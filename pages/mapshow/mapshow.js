
const { parseKml } = require('../../utils/kmlParser');

/**
 * 计算两个经纬度点之间的球面距离（Haversine公式）
 * @param {Object} point1 { latitude: 纬度, longitude: 经度 }（GCJ-02/WGS-84）
 * @param {Object} point2 { latitude: 纬度, longitude: 经度 }
 * @returns {number} 距离（单位：米）
 */
function calculateDistance(point1, point2) {
  const R = 6371000; // 地球半径（米）
  const lat1 = point1.latitude * Math.PI / 180; // 转换为弧度
  const lat2 = point2.latitude * Math.PI / 180;
  const lon1 = point1.longitude * Math.PI / 180;
  const lon2 = point2.longitude * Math.PI / 180;

  const dLat = lat2 - lat1;
  const dLon = lon2 - lon1;

  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1) * Math.cos(lat2) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // 米
}

//考虑高度差（垂直距离），可结合勾股定理计算三维距离：
function calculate3DDistance(point1, point2) {
  const horizontalDist = calculateDistance(point1, point2);
  const verticalDist = Math.abs((point2.altitude || 0) - (point1.altitude || 0));
  return Math.sqrt(horizontalDist ** 2 + verticalDist ** 2); // 三维距离
}

//获取路径轨迹的总距离
function getPathTotalLength(linePoints) {
  if (linePoints.length < 2) return 0;
  return linePoints.slice(0, -1).reduce((sum, current, index) => {
    return sum + calculate3DDistance(current, linePoints[index + 1]);
  }, 0);
}

// 使用加权移动平均平滑高程数据
function smoothElevation(points) {
  return points.map((p, i, arr) => {
    // 第一点和最后一点不处理
    if (i === 0 || i === arr.length - 1) return p;
    
    const prev = arr[i-1].altitude;
    const current = p.altitude;
    const next = arr[i+1].altitude;
    
    return {
      ...p,
      altitude: (prev * 0.2) + (current * 0.6) + (next * 0.2)
    };
  });
}


//计算路线的爬升高度和下降高度
function calculateElevationChange(points){
  if(!points || points.length < 2){
    return {
      climb: 0,
      descent: 0,
    }
  }

  const THRESHOLD = 0.8; // 过滤微小波动的阈值（米）
  let climb = 0; // 总爬升高度
  let descent = 0; // 总下降高度
  let prevElevation = null; // 上一个点的高度

  points.forEach(point=>{
    const currentElevation = point.altitude;
    if(currentElevation === null || currentElevation === undefined){
      return;
    }
    if (prevElevation === null) {
      prevElevation = currentElevation;
      return;
    }
    const elevationChange = currentElevation - prevElevation;
    // 累加爬升和下降高度（过滤微小波动）
    if (elevationChange > THRESHOLD) {
      climb += elevationChange;
    } else if (elevationChange < -THRESHOLD) {
      descent += Math.abs(elevationChange);
    }
    
    prevElevation = currentElevation;
  })
  // 四舍五入到小数点后1位
  climb = Math.round(climb * 10) / 10;
  descent = Math.round(descent * 10) / 10;
  
  return { climb, descent };
}

Page({

  /**
   * 页面的初始数据
   */
  data: {
    isAllowed: true, // 是否允许进入主界面（初始为false）
    routeLength: 0, //路线长度
    climb: 0, //爬升高度
    descent: 0, //下降高度
    mapCenter: {latitude:30,longitude:120}, // 默认地图中心
    altitude: 0, //高度
    markers: [], // 渲染点标记（含高度）
    polylines: [], // 渲染线要素
    includePoints: [],     // 存储所有线点（用于自动调整视野）
    isNavigating: false, // 是否正在导航
    isDeviated: false, // 是否偏离路线
    originalMarkers: [],//原路线点标记
    originalPolylines: [],//原路线线要素
    originalRoute: [], // 原路线坐标点（从KML解析）
    currentLocation: null, // 当前位置
    locationInterval: null, // 定位定时器
    arrivalInterval: null, // 到达检测定时器
  },


   

/**
   * 用户点击上传KML文件
   */
  chooseKmlFile() {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['kml'], // 限制仅KML格式
      success: (res) => {
        if (res.tempFiles.length === 0) return;
        this.readKmlFile(res.tempFiles[0].path); // 读取选中的文件
      },
      fail: (err) => console.error('文件选择失败:', err)
    });
  },

   /**
   * 读取KML文件内容
   * @param {string} tempPath 文件临时路径
   */
  readKmlFile(tempPath) {
    wx.showLoading({ title: '解析KML文件...' });
    const fs = wx.getFileSystemManager();
    
    fs.readFile({
      filePath: tempPath,
      encoding: 'utf-8',
      success: (res) => {
        this.handleKmlParsing(res.data); // 传入解析模块处理
      },
      fail: (err) => {
        wx.hideLoading();
        wx.showToast({ 
          title: `文件读取失败：${err.errMsg}`, 
          icon: 'error', 
          duration: 2000 
        });
      }
    });
  },

  /**
   * 处理KML解析结果
   * @param {string} kmlContent KML文本内容
   */
  handleKmlParsing(kmlContent) {
    try {
      const features = parseKml(kmlContent); // 调用独立解析模块

      
      //测试数据是否正常解析到
      if (features.points.length === 0) {
        console.log('注意：未解析到任何点要素');
      } else {
        console.log(`共解析到${features.points.length}个点要素：`);
        features.points.forEach((point, index) => {
          // 处理可能的无效点（如parsePoint返回的null）
          if (!point) {
            console.log(`第${index + 1}个点：无效数据`);
            return;
          }
          console.log(`第${index + 1}个点:`);
          console.log(`- 名称: ${point.title}`);
          console.log(`- 描述: ${point.description}`);
          console.log(`- 坐标: [纬度${point.latitude}, 经度${point.longitude}, 高度${point.altitude}]`);
        });
      }

      if (features.lines.length === 0) {
        console.log('注意：未解析到任何线要素');
      } else {
        console.log(`共解析到${features.lines.length}个线要素：`);
        features.lines.forEach((line, index) => {
          // 处理可能的无效点（如parsePoint返回的null）
          if (!line) {
            console.log(`第${index + 1}个线：无效数据`);
            return;
          }
          console.log(`第${index + 1}个线:`);
          line.points.forEach((point,index)=>{
            console.log(`第${index + 1}个点:`);
            console.log(`- 坐标: [经度${point.longitude}, 纬度${point.latitude}, 高度${point.altitude}]`);
          });
        });
      }

      // 计算路线总距离
      let totalLength = 0;
      features.lines.forEach((line, index) =>{
        if (!line) {
          console.log(`第${index + 1}个线：无效数据`);
          return;
        }
        totalLength += getPathTotalLength(line.points);
      })
      console.log('路径总长度:', totalLength.toFixed(2), '米'); // 输出保留2位小数
      //转换成公里
      totalLength = totalLength/1000;
      this.setData({
        routeLength:totalLength.toFixed(3),
      })
      this.renderFeaturesToMap(features); // 渲染到地图

    } catch (error) {
      wx.hideLoading();
      wx.showToast({ 
        title: `解析失败：${error.message || '无效的KML格式'}`, 
        icon: 'error', 
        duration: 3000 
      });
      console.error('KML解析错误:', error);
    }
  },

  /**
   * 将解析后的地理要素渲染到地图
   * @param {object} features 包含points/lines/polygons的对象
   */
  renderFeaturesToMap(features) {
    let newPolylines = [];//地图线条数据
    let newMarkers = [];//地图标记点数据
    let newIncludePoints = [];//地图上所有点的数据
    //let newMapCenter = [];//线路中心经纬度
    wx.hideLoading({success: () => {
      console.log('hideLoading 调用成功');
    },
    fail: (error) => {
      console.error('hideLoading 调用失败:', error);
    }});

    //提取标记点
    if(features.points.length != 0){
      const points = features.points;
      // ---------------------- 步骤1：构造markers（标记点） ----------------------
        newMarkers = points.map((point, index) => ({
        id: index,  // 唯一标识（必须）
        latitude: point.latitude,  // 纬度（GCJ-02）
        longitude: point.longitude, // 经度（GCJ-02）
        title: point.title,    // 标记标题（点击时显示）
        iconPath: '/assets/icon/mark.png', // 自定义标记图标（建议尺寸40x40）
        width: 10,   // 图标宽度（单位：px）
        height: 10,  // 图标高度（单位：px）
        callout: {   // 点击标记时显示的气泡（可选）
          content: `位置：${point.title}\n高度：${point.altitude}m`,
          color: '#333',
          bgColor: '#fff',
          padding: 8,
          display: 'BYCLICK' // 始终显示（或'BYCLICK'点击显示）
        }
      }));

       // ---------------------- 步骤2：设置地图中心点和缩放级别 ----------------------
     // newMapCenter = this.calculateMapCenter(points);
    }
    //将目前所在位置设置为地图中心
    //this.getLocation();
    // ---------------------- 步骤3：构造polyline（连线） ----------------------
    if(features.lines.length != 0){
      const lines = features.lines;
    
       lines.forEach((line,index) =>{
          //构造polylines（连接线）
          newPolylines.push({
            id:index, //线的唯一标识
            points:line.points.map(p => ({  // 转换为{ latitude, longitude }格式
              latitude: p.latitude,
              longitude: p.longitude,
              altitude: p.altitude,
            })),
            color: '#84FEFF',  // 线颜色（十六进制）
            //borderColor: '#FF7700', //线边框颜色
            width: 4,          // 线宽度（px）
            arrowLine: true,   // 显示箭头
            dottedLine: false, // 非虚线
            name: line.title   // 线名称（可选）
          });
          // ---------------------- 收集所有点用于调整视野 ----------------------
          newIncludePoints.push(...line.points.map(p => ({
            latitude: p.latitude,
            longitude: p.longitude,
            altitude: p.altitude,
          })));
       })
    }

    //对高度数据进行平滑处理
    const points =smoothElevation(newIncludePoints);
    //根据路线数据计算爬升高度和下降高度
    const {climb,descent} = calculateElevationChange(points);
    // ---------------------- 步骤4：绑定数据到视图 ----------------------
    this.setData({
      originalMarkers: newMarkers,
      markers:newMarkers,
      originalPolylines: newPolylines,
      polylines:newPolylines,
      includePoints:newIncludePoints,
      originalRoute: newIncludePoints,
      mapCenter: newPolylines[0],
      climb: climb.toFixed(0),
      descent:descent.toFixed(0),
    });
    console.log('polylines: ',this.data.polylines);
    console.log('originalRoute: ',this.data.originalRoute);
  },

  /**
   * 计算地图中心点（所有点的几何中心）
   * @param {Array} points 点数组
   * @returns {Object} { latitude, longitude }
   */
  calculateMapCenter(points) {
    const lats = points.map(p => p.coordinates[0]);
    const lngs = points.map(p => p.coordinates[1]);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);

    return {
      latitude: (minLat + maxLat) / 2,  // 纬度中心
      longitude: (minLng + maxLng) / 2   // 经度中心
    };
  },

//开始导航
async startNav() {
  if (this.data.originalRoute.length === 0) {
    wx.showToast({ title: '请先上传路线文件', icon: 'none' });
    return;
  }

  // 检查位置权限
  const { authSetting } = await wx.getSetting();
  if (!authSetting['scope.userLocation']) {
    const { confirm } = await wx.showModal({
      title: '需要位置权限',
      content: '请授权位置权限以使用导航功能'
    });
    if (confirm) wx.openSetting();
    return;
  }

  // 启动导航
  this.setData({ isNavigating: true });
  this.startRealTimeLocation(); // 启动实时定位
},

//实时定位
startRealTimeLocation() {
  // 每秒获取一次位置
  this.locationInterval = setInterval(async () => {
    try {
      const res = await wx.getLocation({
        type: 'gcj02', // 与地图坐标一致
        altitude: true, //启用高精度定位
      });
      const currentLocation = { 
        latitude: res.latitude, 
        longitude: res.longitude 
      };
      //console.log('currentLocation:',currentLocation);
      const newMarkers =  [
        { // 用户位置标记（红色小图标）
          id: 1,
          latitude: currentLocation.latitude,
          longitude: currentLocation.longitude,
          iconPath: '/assets/icon/user-marker.png',
          width: 20,
          height: 20
        },
        { // 路线起点标记
          id: 2,
          latitude: this.data.originalRoute[0].latitude,
          longitude: this.data.originalRoute[0].longitude,
          iconPath: '/assets/icon/mark.png',
          width: 30,
          height: 30,
        },
        { // 路线终点标记
          id: 3,
          latitude: this.data.originalRoute[this.data.originalRoute.length - 1].latitude,
          longitude: this.data.originalRoute[this.data.originalRoute.length - 1].longitude,
          iconPath: '/assets/icon/mark.png',
          width: 30,
          height: 30
        }
      ]
      // 更新当前位置和地图标记
      this.setData({
        currentLocation: currentLocation,
        markers:[...this.data.originalMarkers,...newMarkers],
      });
      console.log('markers',this.data.markers);
      // 检测是否偏离路线
      this.checkDeviation(currentLocation);
    } catch (err) {
      console.error('定位失败:', err);
      wx.showToast({ title: '定位失败，请检查设置', icon: 'none' });
    }
  }, 1000);
},

//偏离路线检测
checkDeviation(currentLocation) {
  const { originalRoute } = this.data;
  if (originalRoute.length < 2) return;

  // 计算当前位置到原路线的最近点和距离
  const { closestPoint, minDistance } = this.findClosestPointOnRoute(currentLocation, originalRoute);
  //console.log('closestPoint',closestPoint);
  //console.log('minDistance',minDistance);
  // 偏离阈值设为10米
  if (minDistance > 10) {
    this.setData({ isDeviated: true });
    this.replanToClosestPoint(currentLocation, closestPoint,minDistance); // 重新规划到最近点
  } else {
    this.setData({ isDeviated: false });
    this.clearTempRoute(); // 未偏离时清除临时路线
  }
},

//重新规划到最近点
replanToClosestPoint(currentLocation, closestPoint,minDistance) {
  // 生成临时路线（当前位置→最近点）
  const tempRoute = [{
    points: [currentLocation, closestPoint],
    color: '#FF5722', // 临时路线红色
    width: 4,
    dottedLine: true // 虚线
  }];
  //console.log('currentLocation',currentLocation);
  //console.log('closestPoint',closestPoint);
  this.setData({
    polylines: [...this.data.originalPolylines, ...tempRoute], // 合并原路线和临时路线
    //includePoints: [currentLocation, ...this.data.originalRoute] // 地图包含当前位置和原路线
  });
  console.log('polylines: ',this.data.polylines);
  wx.showToast({ title: '您已偏离路线，离最近点的距离为'+minDistance.toFixed(0)+' 米', icon: 'none' });

  // 监测是否到达最近点
  this.watchArrivalToClosestPoint(closestPoint);
},
  
//监测是否到最近点
watchArrivalToClosestPoint(closestPoint) {
  if (this.arrivalInterval) clearInterval(this.arrivalInterval);

  this.arrivalInterval = setInterval(() => {
    const currentLocation = this.data.currentLocation;
    if (!currentLocation) return;

    const distance = this.getDistance(currentLocation, closestPoint);
    if (distance < 5) { // 到达最近点（阈值5米）
      clearInterval(this.arrivalInterval);
      this.clearTempRoute(); // 清除临时路线
      wx.showToast({ title: '回到原路线，继续导航', icon: 'none' });
    }
  }, 2000);
},

//结束导航
stopNav() {
  clearInterval(this.locationInterval);
  clearInterval(this.arrivalInterval);
  this.setData({
    isNavigating: false,
    isDeviated: false,
    polylines: this.data.originalPolylines, // 仅保留原路线
    markers: this.data.originalMarkers,
  });
  console.log('polylines: ',this.data.polylines);
  wx.showToast({ title: '导航结束', icon: 'none' });
},

// 计算两点间距离（米）
getDistance(p1, p2) {
  const R = 6371000;
  const dLat = (p2.latitude - p1.latitude) * Math.PI / 180;
  const dLng = (p2.longitude - p1.longitude) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(p1.latitude * Math.PI / 180) * Math.cos(p2.latitude * Math.PI / 180) * 
    Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
  return R * c;
},

 // 寻找当前位置到原路线的最近点
 findClosestPointOnRoute(currentLocation, routePoints) {
  let minDistance = Infinity;
  let closestPoint = null;

  for (let i = 0; i < routePoints.length - 1; i++) {
    const p1 = routePoints[i];
    const p2 = routePoints[i + 1];
    const { distance, point } = this.getDistanceToSegment(currentLocation, p1, p2);
    if (distance < minDistance) {
      minDistance = distance;
      closestPoint = point;
    }
  }

  return { closestPoint, minDistance };
},

 // 计算点到线段的最短距离及最近点
 getDistanceToSegment(P, p1, p2) {
  const x = P.longitude;
  const y = P.latitude;
  const x1 = p1.longitude;
  const y1 = p1.latitude;
  const x2 = p2.longitude;
  const y2 = p2.latitude;

  const dx = x2 - x1;
  const dy = y2 - y1;
  const vx = x - x1;
  const vy = y - y1;

  const t = (vx * dx + vy * dy) / (dx * dx + dy * dy || 1e-9);
  const tClamped = Math.max(0, Math.min(1, t));

  const projX = x1 + tClamped * dx;
  const projY = y1 + tClamped * dy;

  return {
    distance: this.getDistance(P, { latitude: projY, longitude: projX }),
    point: { latitude: projY, longitude: projX }
  };
},

// 清除临时路线
clearTempRoute() {
  this.setData({
    polylines: this.data.originalPolylines, // 仅保留原路线
  });
},

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad(options) {
    console.log('onLoad调用成功');
    // 启动权限校验流程
    this.checkLocationPermission();
    this.getLocation();
  },

  //获取位置信息
  getLocation(){
      //获取当前定位
      wx.getLocation({
        type: 'gcj02', // 返回GCJ-02坐标系（微信地图默认）
        altitude: true, // 启用高精度定位
        success: (res) => {
          console.log('获取位置成功');
          // 让地图显示目前所作地址
          this.setData({
            mapCenter: {
              latitude: res.latitude,
              longitude: res.longitude
            },
            altitude: res.altitude
          });
        },
        fail: (err) => {
          console.log('获取位置失败');
          console.log(err);
          //this.getLocation();
      }
    });
  },

// 核心校验流程
checkLocationPermission() {
  console.log('进入checkLocationPermission()');
  // 步骤1：检查小程序位置权限
  const isAuth = this.checkMiniProgramAuth();
  if (!isAuth) return; // 未授权，流程终止（继续显示遮罩）

  // 步骤2：检查系统定位是否开启
  const isLocationOn =  this.checkSystemLocation();
  if (!isLocationOn) return; // 系统定位未开启，流程终止

  // 所有条件满足，进入主界面
  this.setData({ isAllowed: true });
},

// 检查小程序位置权限（返回是否已授权）
checkMiniProgramAuth() {
  console.log('进入checkMiniProgramAuth()');
  return new Promise((resolve) => {
    wx.getSetting({
      success: (res) => {
        console.log('进入getSetting success');
        if (res.authSetting['scope.userLocation']) {
          console.log('位置授权success');
          resolve(true); // 已授权
        } else {
          // 未授权，请求授权
          wx.authorize({
            scope: 'scope.userLocation',
            success: () => resolve(true), // 授权成功
            fail: () => {
              // 授权失败，引导用户到小程序设置页
              this.showAuthGuide('小程序位置权限', () => {
                wx.openSetting({
                  success: (settingRes) => {
                    // 用户返回后重新检查权限
                    this.checkMiniProgramAuth().then(resolve);
                  }
                });
              });
            }
          });
        }
      }
    });
  });
},

// 检查系统定位是否开启（返回是否已开启）
checkSystemLocation() {
  console.log('进入checkSystemLocation()');
  return new Promise((resolve) => {
    wx.getLocation({
      type: 'gcj02',
      altitude: true, // 启用高精度定位
        success: (res) => {
          console.log('获取位置成功');
          resolve(true),// 系统定位已开启
          // 让地图显示目前所作地址
          this.setData({
            mapCenter: {
              latitude: res.latitude,
              longitude: res.longitude
            },
            altitude: res.altitude
          });
        },
      fail: (err) => {
        console.log('获取位置信息失败');
          // 系统定位未开启，引导用户开启
          this.showAuthGuide('手机系统定位', () => {
            //this.openSystemLocationSettings();
            // 监听用户返回，重新检查系统定位
            wx.onAppShow(() => {
              this.checkSystemLocation().then(resolve);
            });
          });
      }
    });
  });
},

// 显示权限引导模态框
showAuthGuide(type, confirmCallback) {
  console.log('进入showAuthGuide()');
  wx.showModal({
    title: '权限需要',
    content: `需要开启${type}以使用本功能，请前往设置`,
    success: (res) => {
      if (res.confirm) {
        confirmCallback(); // 点击确定后执行回调（如跳转设置）
      } else {
        // 用户拒绝，重新提示
        this.showAuthGuide(type, confirmCallback);
      }
    }
  });
},





  /**
   * 标记点点击：显示高度和详情
   */
  onMarkerTap(e) {
    const marker = this.data.markers.find(m => m.id === e.markerId);
    wx.showModal({
      title: `标记点：${marker.title}`,
      content: `经纬度：${marker.longitude.toFixed(6)}, ${marker.latitude.toFixed(6)}\n高度：${marker.altitude || '无'}米`
    });
  },

  /**
   * 生命周期函数--监听页面初次渲染完成
   */
  onReady() {

  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow() {

  },

  /**
   * 生命周期函数--监听页面隐藏
   */
  onHide() {

  },

  /**
   * 生命周期函数--监听页面卸载
   */
  onUnload() {

  },

  /**
   * 页面相关事件处理函数--监听用户下拉动作
   */
  onPullDownRefresh() {

  },

  /**
   * 页面上拉触底事件的处理函数
   */
  onReachBottom() {

  },

  /**
   * 用户点击右上角分享
   */
  onShareAppMessage() {

  }
})