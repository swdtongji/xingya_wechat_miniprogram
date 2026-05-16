// pages/index/index.js
const { ble, strToBuffer } = require('../../utils/ble.js');

// 本地存储键
const LS_HISTORY = 'xingya_send_history';

function nowHHMMSS() {
  const d = new Date();
  const pad = (n) => n.toString().padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

Page({
  data: {
    scanning: false,
    connected: false,
    statusText: '未连接',
    devices: [],

    text: '',
    byteLen: 0,
    sending: false,

    // 快捷文本（方便测试 DLC 兑换码等）
    presets: [
      'ABCD1234EFGH5678',
      '你好，ESP32 👋',
      '测试中文输入',
      '1234567890'
    ],

    history: [],

    logs: []
  },

  onLoad() {
    // 还原历史
    const his = wx.getStorageSync(LS_HISTORY) || [];
    this.setData({ history: his });

    // 调试：把广播包原始 hex 打到日志区
    ble.debugLog = (msg) => this.log(msg, 'warn');

    // 监听系统蓝牙开关状态：用户手动打开蓝牙后自动重试 init
    this._adapterListenerBound = true;
    wx.onBluetoothAdapterStateChange((res) => {
      this.log('蓝牙开关状态变化: available=' + res.available + ' discovering=' + res.discovering, 'warn');
      if (res.available && !ble._listenerBound) {
        this.log('检测到蓝牙已打开，自动重新初始化...', 'info');
        this._tryInit();
      }
    });

    // 首次初始化
    this._tryInit();

    // 注册设备发现回调
    ble.onDeviceFound = (d) => {
      // 排序：xingya_ 设备置顶，其他按信号强度排序
      const list = ble.foundDevices.slice().sort((a, b) => {
        if (a.isTarget && !b.isTarget) return -1;
        if (!a.isTarget && b.isTarget) return 1;
        return (b.rssi || -999) - (a.rssi || -999);
      });
      this.setData({ devices: list });
      if (d.isTarget) {
        this.log('✅ 发现目标: ' + (d.name || d.localName), 'info');
      }
    };
    ble.onDisconnect = () => {
      this.log('连接已断开', 'warn');
      this.setData({
        connected: false,
        statusText: '未连接'
      });
    };
  },

  // BLE 初始化（失败给出可重试的弹框）
  _tryInit() {
    ble.init().then(() => {
      this.log('蓝牙模块已就绪', 'info');
    }).catch((e) => {
      const errMsg = e.errMsg || JSON.stringify(e);
      const errCode = e.errCode != null ? e.errCode : (e.code != null ? e.code : '');
      this.log('蓝牙初始化失败: ' + errMsg, 'error');

      if (e.needOpenSetting) {
        wx.showModal({
          title: '权限未授权',
          content: errMsg || '请在设置中开启相关权限',
          confirmText: '去设置',
          cancelText: '稍后',
          success: (res) => {
            if (res.confirm) wx.openSetting();
          }
        });
        return;
      }

      // openBluetoothAdapter 失败：通常是手机蓝牙没打开 / 模拟器 / iOS 微信没系统蓝牙权限
      // 小程序无法主动弹「打开蓝牙」的系统框，只能提示用户手动开启
      wx.showModal({
        title: '蓝牙未开启',
        content: '错误码: ' + errCode + '\n' +
          '错误信息: ' + errMsg + '\n\n' +
          '排查项:\n' +
          '① 手机蓝牙开关是否已打开\n' +
          '② Android 是否授予定位权限\n' +
          '③ iOS 系统设置→微信→蓝牙 开关\n' +
          '④ 必须真机预览（模拟器不支持）',
        confirmText: '重试',
        cancelText: '取消',
        success: (res) => {
          if (res.confirm) this._tryInit();
        }
      });
    });
  },

  onUnload() {
    // 页面销毁时断开并关闭蓝牙
    ble.disconnect().finally(() => {
      try { wx.closeBluetoothAdapter(); } catch (e) {}
    });
  },

  // --------------- 扫描 ---------------
  async onTapScan() {
    this.setData({ scanning: true, statusText: '扫描中...', devices: [] });
    this.log('开始扫描 xingya_ 设备');
    try {
      await ble.init();
      await ble.startScan();
    } catch (e) {
      this.log('扫描失败: ' + (e.errMsg || JSON.stringify(e)), 'error');
      this.setData({ scanning: false, statusText: '扫描失败' });
    }
  },

  async onTapStopScan() {
    await ble.stopScan();
    this.setData({ scanning: false, statusText: '未连接' });
    this.log('停止扫描');
  },

  // --------------- 连接 ---------------
  async onTapDevice(e) {
    const id = e.currentTarget.dataset.id;
    const dev = this.data.devices.find(d => d.deviceId === id);
    if (!dev) return;

    this.setData({ scanning: false, statusText: `正在连接 ${dev.name}...` });
    wx.showLoading({ title: '连接中', mask: true });
    this.log('连接设备: ' + dev.name);

    try {
      await ble.connect(id);
      wx.hideLoading();
      this.setData({
        connected: true,
        statusText: '已连接: ' + dev.name
      });
      this.log('连接成功 ✓ MTU 协商 / 服务发现完成', 'info');
    } catch (err) {
      wx.hideLoading();
      const msg = err.errMsg || JSON.stringify(err);
      this.log('连接失败: ' + msg, 'error');
      this.setData({ statusText: '连接失败' });
      wx.showToast({ title: '连接失败', icon: 'error' });
    }
  },

  async onTapDisconnect() {
    await ble.disconnect();
    this.setData({
      connected: false,
      statusText: '未连接',
      text: '',
      byteLen: 0
    });
    this.log('主动断开');
  },

  // --------------- 发送 ---------------
  onTextInput(e) {
    const v = e.detail.value;
    const buf = strToBuffer(v);
    this.setData({ text: v, byteLen: buf.byteLength });
  },

  async onTapSend() {
    const text = this.data.text;
    if (!text) {
      wx.showToast({ title: '内容为空', icon: 'none' });
      return;
    }
    const bytes = strToBuffer(text).byteLength;
    if (bytes > 240) {
      wx.showToast({ title: 'UTF-8 > 240 字节，请缩短', icon: 'none' });
      return;
    }
    if (!ble.connected) {
      wx.showToast({ title: '未连接', icon: 'none' });
      return;
    }
    this.setData({ sending: true });
    this.log('发送: ' + text + ' (' + bytes + 'B)');
    try {
      await ble.sendText(text);
      this.log('发送成功 ✓', 'info');
      this.pushHistory(text, bytes);
      wx.showToast({ title: '已发送', icon: 'success' });
    } catch (err) {
      const msg = err.errMsg || JSON.stringify(err);
      this.log('发送失败: ' + msg, 'error');
      wx.showToast({ title: '发送失败', icon: 'error' });
    } finally {
      this.setData({ sending: false });
    }
  },

  onTapClear() {
    this.setData({ text: '', byteLen: 0 });
  },

  onTapPreset(e) {
    const v = e.currentTarget.dataset.val;
    const buf = strToBuffer(v);
    this.setData({ text: v, byteLen: buf.byteLength });
  },

  onTapHistory(e) {
    const v = e.currentTarget.dataset.val;
    const buf = strToBuffer(v);
    this.setData({ text: v, byteLen: buf.byteLength });
  },

  onTapClearHistory() {
    wx.removeStorageSync(LS_HISTORY);
    this.setData({ history: [] });
  },

  // --------------- 工具 ---------------
  pushHistory(text, bytes) {
    const item = {
      text,
      bytes,
      time: nowHHMMSS(),
      ts: Date.now()
    };
    const history = [item, ...this.data.history].slice(0, 20);
    this.setData({ history });
    wx.setStorageSync(LS_HISTORY, history);
  },

  log(msg, level) {
    level = level || 'info';
    const entry = {
      msg,
      level,
      time: nowHHMMSS(),
      ts: Date.now() + Math.random()
    };
    const logs = [entry, ...this.data.logs].slice(0, 60);
    this.setData({ logs });
    console.log('[LOG]', level, msg);
  },

  onTapClearLog() {
    this.setData({ logs: [] });
  }
});
