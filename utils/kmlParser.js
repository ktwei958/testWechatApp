// 引入依赖
const { DOMParser } = require('@xmldom/xmldom');
import { wgs84ToGcj02 } from '../utils/coordTransform';

/**
 * 解析KML文件内容为地理要素对象
 * @param {string} kmlStr KML文本内容
 * @returns {object} { points: [], lines: [], polygons: [] }
 */
function parseKml(kmlStr) {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(kmlStr, 'text/xml');
  const features = { points: [], lines: [], polygons: [] };

  // 获取所有<Placemark>标签（KML中的核心地理要素标签）
  const placemarks = xmlDoc.getElementsByTagName('Placemark');

  // 遍历（需转换为数组，避免LiveNodeList无forEach的问题）
  Array.from(placemarks).forEach(placemark => {
    const name = getXmlText(placemark, 'name');
    const description = getXmlText(placemark, 'description');

    // 解析点要素
    const point = placemark.getElementsByTagName('Point')[0];
    if (point) {
      features.points.push(parsePoint(point, name, description));
      return;
    }

    // 解析线要素
    const line = placemark.getElementsByTagName('LineString')[0];
    if (line) {
      const lineData = parseLine(line,name,description);
      if(lineData.points.length > 0){//仅添加有效线，点数大于0
        features.lines.push(lineData);
      }
      return;
    }

    // 解析面要素
    const polygon = placemark.getElementsByTagName('Polygon')[0];
    if (polygon) {
      features.polygons.push(parsePolygon(polygon, name, description));
    }
  });

  return features;
}

// ---------------------- 具体要素解析函数 ----------------------
//解析点数据
function parsePoint(pointElem, name, desc) {
  const coordsStr = getXmlText(pointElem, 'coordinates');
  const coords = coordsStr.split(',').map(Number);
  
  // 校验坐标是否有效（至少包含经度、纬度，且为数字）
  if (coords.length < 2 || coords.some(isNaN)) {
    console.warn(`无效点坐标: ${coordsStr}`);
    return null; // 返回null表示无效点
  }
  // 转换坐标系：WGS-84 → GCJ-02
  const [gcjLon, gcjLat] = wgs84ToGcj02(coords[0], coords[1]);
  return { 
    title: name, 
    description: desc, 
    longitude: gcjLon,  // 转换后的经度（GCJ-02）
    latitude: gcjLat,   // 转换后的纬度（GCJ-02）
    altitude: coords[2] || 0 , // 高度（可选，默认0）
   };
}
//解析线数据
function parseLine(lineElem, name, desc) {
  // 获取原始坐标字符串（如"116.397428,39.90923,0 116.40128,39.91235,0"）
  const coordsStr = getXmlText(lineElem, 'coordinates').trim();

  // 分割为单个坐标点（按空格分割）
  const coordPoints = coordsStr.split(' ');

  // 解析并验证每个点
  const validPoints = coordPoints.map(coord => {
    const [lon, lat, alt] = coord.split(',').map(Number);
    
    // 校验坐标有效性（经度范围：-180~180，纬度：-90~90）
    if (isNaN(lon) || isNaN(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) {
      console.warn(`无效线坐标: ${coord}`);
      return null;
    }
    
    // 坐标系转换（WGS-84 → GCJ-02，若KML已为GCJ-02则跳过）
    const [gcjLon, gcjLat] = wgs84ToGcj02(lon, lat);
    
    return {
      longitude: gcjLon,  // 转换后的经度（GCJ-02）
      latitude: gcjLat,   // 转换后的纬度（GCJ-02）
      altitude: alt || 0  // 高度（可选，默认0）
    };
  }).filter(p => p !== null); // 过滤无效点

  return {
    title: name || '未命名线',
    description: desc || '无描述',
    points: validPoints // 有效坐标点数组（格式：{ longitude, latitude, altitude }）
  };
}

function parsePolygon(polygonElem, name, desc) {
  const outerBoundary = polygonElem.getElementsByTagName('outerBoundaryIs')[0];
  const innerBoundaries = Array.from(polygonElem.getElementsByTagName('innerBoundaryIs'));

  const outerCoords = getXmlText(outerBoundary, 'coordinates')
    .trim()
    .split(' ')
    .map(coord => coord.split(',').map(Number));

  const innerCoords = innerBoundaries.map(ib => 
    getXmlText(ib, 'coordinates')
      .trim()
      .split(' ')
      .map(coord => coord.split(',').map(Number))
  );

  return {
    title: name,
    description: desc,
    outer: outerCoords, // 外层环坐标
    inner: innerCoords  // 内层环坐标数组（可能多个）
  };
}

// ---------------------- 辅助函数 ----------------------
function getXmlText(parent, tagName) {
  return parent.getElementsByTagName(tagName)[0]?.textContent?.trim() || '';
}

module.exports = { parseKml };