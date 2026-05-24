// utils/ble.js
// 星芽 ESP32 BLE 文本输入封装
// ------------------------------------------------------------
// 协议（对应 ESP32 端 main/bluetooth_manager.h）：
//   Service UUID  : 0x00FF   -> 128-bit: 000000FF-0000-1000-8000-00805F9B34FB
//   Write   UUID  : 0xFF01   -> 0000FF01-...
//   Notify  UUID  : 0xFF02   -> 0000FF02-...
//   设备名前缀     : "xingya_"
//   写入方式      : Write with Response
// ------------------------------------------------------------

const app = getApp();

// 微信小程序返回的 UUID 格式统一为大写
// 注意：16-bit UUID 0xXXXX 的 128-bit 展开格式是 0000XXXX-0000-1000-8000-00805F9B34FB
//   ESP32 端 Service = 0x00FF -> 000000FF-...
//   ESP32 端 Write   = 0xFF01 -> 0000FF01-...
//   ESP32 端 Notify  = 0xFF02 -> 0000FF02-...
const SERVICE_UUID = '000000FF-0000-1000-8000-00805F9B34FB';
const WRITE_UUID   = '0000FF01-0000-1000-8000-00805F9B34FB';
const NOTIFY_UUID  = '0000FF02-0000-1000-8000-00805F9B34FB';
const NAME_PREFIX  = 'xingya_';

// 统一 UUID 比较（忽略大小写 / 短格式）
function uuidEq(a, b) {
  if (!a || !b) return false;
  return String(a).toUpperCase() === String(b).toUpperCase();
}

// 字符串 -> ArrayBuffer（UTF-8）
function strToBuffer(str) {
  // 小程序环境支持 TextEncoder（基础库 2.21.0+），兜底手写
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str).buffer;
  }
  // 手写 UTF-8 编码
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
    } else if (c < 0xD800 || c >= 0xE000) {
      out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
    } else {
      // 代理对 surrogate pair
      i++;
      c = 0x10000 + (((c & 0x3FF) << 10) | (str.charCodeAt(i) & 0x3FF));
      out.push(0xF0 | (c >> 18),
               0x80 | ((c >> 12) & 0x3F),
               0x80 | ((c >> 6) & 0x3F),
               0x80 | (c & 0x3F));
    }
  }
  const u8 = new Uint8Array(out);
  return u8.buffer;
}

// ArrayBuffer -> 字符串（UTF-8）
function bufferToStr(buffer) {
  const bytes = new Uint8Array(buffer);
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder('utf-8').decode(bytes);
  }
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i++];
    if (b < 0x80) {
      out += String.fromCharCode(b);
    } else if (b < 0xE0) {
      out += String.fromCharCode(((b & 0x1F) << 6) | (bytes[i++] & 0x3F));
    } else if (b < 0xF0) {
      out += String.fromCharCode(((b & 0x0F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F));
    } else {
      // 4字节 -> 代理对
      const cp = (((b & 0x07) << 18) | ((bytes[i++] & 0x3F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F)) - 0x10000;
      out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
    }
  }
  return out;
}

// --------------------------- Promise 封装 wx.* ---------------------------
function wxPromise(fn, opts) {
  return new Promise((resolve, reject) => {
    fn({
      ...opts,
      success: resolve,
      fail: reject
    });
  });
}

// --------------------------- 广播包解析 ---------------------------
// 从 BLE 广播包的原始字节里解析设备名
// 格式：[len][type][data...][len][type][data...] ...
//   type = 0x09 Complete Local Name
//   type = 0x08 Shortened Local Name
// Android 上 wx.onBluetoothDeviceFound 给的 d.name / d.localName 常为空，
// 必须从 advertisData + scanResponse 手动解析。
// ArrayBuffer -> hex字符串（用于调试打印广播包）
function bufToHex(buffer) {
  if (!buffer) return '';
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
}

function parseLocalNameFromAdv(advertisData) {
  if (!advertisData) return '';
  const bytes = new Uint8Array(advertisData);
  let i = 0;
  while (i < bytes.length) {
    const len = bytes[i];
    if (len === 0) break;
    if (i + len >= bytes.length) break;
    const type = bytes[i + 1];
    if (type === 0x09 || type === 0x08) {
      const nameBytes = bytes.slice(i + 2, i + 1 + len);
      return bufferToStr(nameBytes.buffer);
    }
    i += len + 1;
  }
  return '';
}

// 兼容微信 Android 特有 BUG：advertisData 结构重组后指标对不上，
// AD 解析拿不到 name。改为直搜“xingya_”字节序列，后接 12 位 MAC hex 共 19 字符。
function findXingyaInBytes(buffer) {
  if (!buffer) return '';
  const bytes = new Uint8Array(buffer);
  // "xingya_" = 78 69 6E 67 79 61 5F
  const sig = [0x78, 0x69, 0x6E, 0x67, 0x79, 0x61, 0x5F];
  for (let i = 0; i <= bytes.length - sig.length; i++) {
    let ok = true;
    for (let j = 0; j < sig.length; j++) {
      if (bytes[i + j] !== sig[j]) { ok = false; break; }
    }
    if (ok) {
      const end = Math.min(bytes.length, i + 19);
      return bufferToStr(bytes.slice(i, end).buffer);
    }
  }
  return '';
}

// --------------------------- 核心 API ---------------------------
class BLEClient {
  constructor() {
    this.deviceId = '';
    this.connected = false;
    this.foundDevices = [];   // 扫描到的 xingya_ 设备
    this.onDeviceFound = null; // (device) => void
    this.onDisconnect = null;  // () => void
    this._listenerBound = false;
    this._pollTimer = null;    // 轮询定时器
    this.debugLog = null;      // (msg) => void, 用于显示到 UI
  }

  // 检查并申请蓝牙/定位权限
  async _checkAndRequestPermissions() {
    const setting = await wxPromise(wx.getSetting);
    const auth = setting.authSetting || {};

    const needBluetooth = !auth['scope.bluetooth'];
    const needLocation = !auth['scope.userLocation'];

    if (needBluetooth) {
      // scope.bluetooth 在老版本微信不存在 / 静默失败属正常，不阻断后续流程
      // 真正的蓝牙能力由 openBluetoothAdapter 决定，授权失败这里直接跳过
      try {
        await wxPromise(wx.authorize, { scope: 'scope.bluetooth' });
      } catch (e) {
        if (this.debugLog) this.debugLog('scope.bluetooth 授权跳过: ' + (e && e.errMsg));
      }
    }

    if (needLocation) {
      try {
        await wxPromise(wx.authorize, { scope: 'scope.userLocation' });
      } catch (e) {
        // 定位授权失败不阻断蓝牙初始化，仅警告
        // 原因：requiredPrivateInfos 未配置时 wx.authorize 会静默失败
        // Android 扫描 BLE 会受影响，但连接/发送仍可正常使用
        if (this.debugLog) this.debugLog('⚠️ 定位权限未授权（Android 扫描可能受影响）: ' + (e && e.errMsg));
      }
    }
  }

  // 打开蓝牙 + 注册全局监听（只注册一次）
  async init() {
    await this._checkAndRequestPermissions();
    await wxPromise(wx.openBluetoothAdapter);
    if (!this._listenerBound) {
      wx.onBluetoothDeviceFound((res) => {
        for (const d of res.devices) {
          // 优先级：d.name > d.localName > advertisData 解析 > scanResponse
          let name = d.name || d.localName || '';
          if (!name) name = parseLocalNameFromAdv(d.advertisData);
          if (!name && d.scanResponse) name = parseLocalNameFromAdv(d.scanResponse);
          // 兼容微信 Android 解析 BUG：按字节直搜 xingya_
          if (!name) name = findXingyaInBytes(d.advertisData);
          if (!name && d.scanResponse) name = findXingyaInBytes(d.scanResponse);

          // 调试：每当连到强信号设备时写一条广播包原始 hex
          if (this.debugLog && d.RSSI > -70) {
            const adv = d.advertisData ? bufToHex(d.advertisData) : '(empty)';
            const sr  = d.scanResponse ? bufToHex(d.scanResponse) : '(empty)';
            this.debugLog(`[RAW RSSI=${d.RSSI}] adv=${adv} sr=${sr}`);
          }

          if (!name) name = '(no name)';
          const isTarget = name.startsWith(NAME_PREFIX);

          const exist = this.foundDevices.find(x => x.deviceId === d.deviceId);
          if (exist) {
            // 已存在但之前名字是 (no name)，尝试补全
            if (exist.name === '(no name)' && name !== '(no name)') {
              exist.name = name;
              exist.isTarget = isTarget;
            }
            exist.rssi = d.RSSI;
            if (this.onDeviceFound) this.onDeviceFound({ ...d, name, isTarget });
            continue;
          }
          this.foundDevices.push({
            deviceId: d.deviceId,
            name: name,
            rssi: d.RSSI,
            isTarget: isTarget
          });
          if (this.onDeviceFound) this.onDeviceFound({ ...d, name, isTarget });
        }
      });
      wx.onBLEConnectionStateChange((res) => {
        if (res.deviceId === this.deviceId && !res.connected) {
          this.connected = false;
          app.globalData.connected = false;
          if (this.onDisconnect) this.onDisconnect();
        }
      });
      this._listenerBound = true;
    }
  }

  // 开始扫描
  async startScan() {
    this.foundDevices = [];
    // 注意：ESP32 广播包里没有携带 Service UUID（只有设备名），
    // 如果传 services: [SERVICE_UUID]，Android 会在系统层过滤掉 -> 扫不到。
    // 因此不传 services，全扫后在回调里按名称前缀 xingya_ 过滤。
    await wxPromise(wx.startBluetoothDevicesDiscovery, {
      allowDuplicatesKey: false,
      powerLevel: 'high',     // 提高扫描功率（基础库 2.14.0+）
      interval: 0             // 0 = 尽可能快
    });
    // 启动轮询：定期调 getBluetoothDevices 拿完整缓存列表
    // （有些机型的 onBluetoothDeviceFound 只在 name 变化时打一次，而 getBluetoothDevices 常新时常新）
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = setInterval(() => {
      wx.getBluetoothDevices({
        success: (r) => {
          for (const d of r.devices) {
            let name = d.name || d.localName || '';
            if (!name) name = parseLocalNameFromAdv(d.advertisData);
            if (!name && d.scanResponse) name = parseLocalNameFromAdv(d.scanResponse);
            if (!name) name = findXingyaInBytes(d.advertisData);
            if (!name && d.scanResponse) name = findXingyaInBytes(d.scanResponse);
            if (!name) continue;      // 轮询阶段只补齐有名字的
            const isTarget = name.startsWith(NAME_PREFIX);
            const exist = this.foundDevices.find(x => x.deviceId === d.deviceId);
            if (exist && exist.name === '(no name)') {
              exist.name = name;
              exist.isTarget = isTarget;
              if (this.onDeviceFound) this.onDeviceFound({ ...d, name, isTarget });
            } else if (!exist) {
              this.foundDevices.push({ deviceId: d.deviceId, name, rssi: d.RSSI, isTarget });
              if (this.onDeviceFound) this.onDeviceFound({ ...d, name, isTarget });
            }
          }
        }
      });
    }, 1500);
  }

  async stopScan() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    try { await wxPromise(wx.stopBluetoothDevicesDiscovery); } catch (e) {}
  }

  // 连接并完成服务发现
  async connect(deviceId) {
    this.deviceId = deviceId;
    await this.stopScan();

    const dbg = (msg) => { if (this.debugLog) this.debugLog(msg); console.log('[BLE]', msg); };

    dbg('createBLEConnection...');
    try {
      await wxPromise(wx.createBLEConnection, { deviceId, timeout: 10000 });
    } catch (e) {
      dbg('createBLEConnection FAIL: ' + JSON.stringify(e));
      throw new Error('建立连接失败: ' + (e && (e.errMsg || e.errCode)));
    }
    dbg('createBLEConnection OK');

    // 协商大 MTU，支持长文本（需要基础库 2.11.0+；iOS 会自动由系统协商，该调用可能失败但不影响）
    try {
      const mtuRes = await wxPromise(wx.setBLEMTU, { deviceId, mtu: 247 });
      dbg('setBLEMTU OK: ' + JSON.stringify(mtuRes));
    } catch (e) {
      dbg('setBLEMTU skip: ' + (e && e.errMsg));
    }

    // 获取服务
    let svcRes;
    try {
      svcRes = await wxPromise(wx.getBLEDeviceServices, { deviceId });
    } catch (e) {
      dbg('getBLEDeviceServices FAIL: ' + JSON.stringify(e));
      throw new Error('获取服务失败: ' + (e && (e.errMsg || e.errCode)));
    }
    const uuids = (svcRes.services || []).map(s => s.uuid).join(', ');
    dbg('services=[' + uuids + ']');

    // 优先严格匹配，其次按 16-bit 短值 00FF 宽松匹配
    let svc = svcRes.services.find(s => uuidEq(s.uuid, SERVICE_UUID));
    if (!svc) {
      svc = svcRes.services.find(s => {
        const u = String(s.uuid).toUpperCase();
        return u.indexOf('000000FF-') === 0 || u === '00FF' || u.indexOf('00FF-') === 0;
      });
      if (svc) dbg('fallback matched service: ' + svc.uuid);
    }
    if (!svc) {
      throw new Error('未找到 Service 000000FF (实际: ' + uuids + ')');
    }
    this.serviceId = svc.uuid;

    // 获取特征值
    let chrRes;
    try {
      chrRes = await wxPromise(wx.getBLEDeviceCharacteristics, {
        deviceId,
        serviceId: svc.uuid
      });
    } catch (e) {
      dbg('getBLEDeviceCharacteristics FAIL: ' + JSON.stringify(e));
      throw new Error('获取特征值失败: ' + (e && (e.errMsg || e.errCode)));
    }
    const chrUuids = (chrRes.characteristics || []).map(c => c.uuid).join(', ');
    dbg('chars=[' + chrUuids + ']');

    // 记录真实的 write / notify 特征 UUID（用实际返回值而非硬编码常量）
    const findChar = (target) => {
      const t = String(target).toUpperCase();
      return chrRes.characteristics.find(c => {
        const u = String(c.uuid).toUpperCase();
        if (u === t) return true;
        // 短值兜底：0000FF01-... vs FF01
        const short = t.substring(4, 8); // FF01
        return u === short || u.indexOf('0000' + short + '-') === 0;
      });
    };
    const wChar = findChar(WRITE_UUID);
    const nChar = findChar(NOTIFY_UUID);
    if (!wChar) throw new Error('未找到 Write 特征 FF01');
    this.writeCharId = wChar.uuid;
    this.notifyCharId = nChar ? nChar.uuid : NOTIFY_UUID;

    this.connected = true;
    app.globalData.deviceId = deviceId;
    app.globalData.connected = true;
    dbg('connect DONE');
  }

  async disconnect() {
    if (!this.deviceId) return;
    try {
      await wxPromise(wx.closeBLEConnection, { deviceId: this.deviceId });
    } catch (e) {}
    this.connected = false;
    app.globalData.connected = false;
  }

  // 发送文本（UTF-8）
  async sendText(text) {
    if (!this.connected) throw new Error('未连接');
    const buf = strToBuffer(text);
    if (buf.byteLength > 240) {
      // ESP32 侧单次最多 255 字节；留余量
      throw new Error('文本过长 (> 240 字节 UTF-8)');
    }
    await wxPromise(wx.writeBLECharacteristicValue, {
      deviceId: this.deviceId,
      serviceId: this.serviceId || SERVICE_UUID,
      characteristicId: this.writeCharId || WRITE_UUID,
      value: buf,
      writeType: 'write'  // with response
    });
  }

  // 启用 notify（从 ESP32 主动 push 数据，可选）
  async enableNotify(onData) {
    if (!this.connected) throw new Error('未连接');
    await wxPromise(wx.notifyBLECharacteristicValueChange, {
      deviceId: this.deviceId,
      serviceId: this.serviceId || SERVICE_UUID,
      characteristicId: this.notifyCharId || NOTIFY_UUID,
      state: true
    });
    const targetNotify = this.notifyCharId || NOTIFY_UUID;
    wx.onBLECharacteristicValueChange((res) => {
      if (!uuidEq(res.characteristicId, targetNotify)) return;
      if (onData) onData(bufferToStr(res.value));
    });
  }
}

// 导出单例
const ble = new BLEClient();
module.exports = {
  ble,
  SERVICE_UUID,
  WRITE_UUID,
  NOTIFY_UUID,
  NAME_PREFIX,
  strToBuffer,
  bufferToStr
};
