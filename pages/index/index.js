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
    bleReady: false,        // 蓝牙初始化是否成功（控制顶部警告条显示）
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

    logs: [],
    showPrivacy: false,
    showOpenSetting: false   // 是否显示「去设置」按钮（open-type="openSetting"）
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

    // 注册隐私弹窗回调：当 app 层触发 onNeedPrivacyAuthorization 时显示弹窗
    getApp()._onNeedPrivacy = () => {
      this.setData({ showPrivacy: true });
    };

    // 检查隐私协议状态：已同意则直接初始化，否则等弹窗
    if (getApp().globalData.privacyAgreed) {
      this._tryInit();
    } else {
      // 等待用户同意隐私协议后再初始化
      this.log('等待用户同意隐私协议...', 'warn');
    }

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

  // 隐私协议同意回调
  onPrivacyAgree() {
    this.setData({ showPrivacy: false });
    getApp().agreePrivacy();
    this.log('用户已同意隐私协议', 'info');
    // 同意后开始 BLE 初始化
    this._tryInit();
  },

  // BLE 初始化（失败给出可重试的弹框）
  _tryInit() {
    ble.init().then(() => {
      this.setData({ bleReady: true });
      this.log('蓝牙模块已就绪', 'info');
    }).catch((e) => {
      this.setData({ bleReady: false });
      const errMsg = e.errMsg || JSON.stringify(e);
      const errCode = e.errCode != null ? e.errCode : (e.code != null ? e.code : '');
      this.log('蓝牙初始化失败: ' + errMsg, 'error');

      // 避免重复弹框：如果已经有弹框在显，不再弹
      if (this._modalShowing) return;
      this._modalShowing = true;

      const tip = e.needOpenSetting
        ? '权限未授权：' + errMsg
        : '错误码: ' + errCode + '\n错误信息: ' + errMsg + '\n\n' +
          '可能原因：\n' +
          '① 手机蓝牙未打开\n' +
          '② 微信未授权蓝牙/定位\n' +
          '③ 必须真机预览';

      wx.showModal({
        title: '需要授权',
        content: tip,
        confirmText: '去授权',
        cancelText: '稍后',
        success: (res) => {
          this._modalShowing = false;
          if (res.confirm) this.onTapRequestPerm();
        },
        fail: () => { this._modalShowing = false; }
      });
    });
  },

  onShow() {
    // 从设置页/后台返回时如果 BLE 还没就绪，重试一次
    if (!this.data.bleReady && !this._modalShowing) {
      this.log('onShow: BLE 未就绪，重试初始化', 'warn');
      this._tryInit();
    }
  },

  onUnload() {
    // 页面销毁时断开并关闭蓝牙
    ble.disconnect().finally(() => {
      try { wx.closeBluetoothAdapter(); } catch (e) {}
    });
  },

  // --------------- 权限 ---------------
  // 手动申请权限 / 重试 BLE 初始化
  // 点击后会依次尝试：
  //   1. 查询当前 authSetting 打到日志
  //   2. 主动 wx.authorize 请求蓝牙/定位两个 scope（首次会弹系统授权框）
  //   3. 任何失败都显示「去设置」按钮（open-type="openSetting"，微信唯一可靠方式）
  //   4. 返回后重新 _tryInit
  async onTapRequestPerm() {
    this.log('=== 手动申请权限 ===', 'info');
    try {
      const setting = await new Promise((res, rej) => wx.getSetting({ success: res, fail: rej }));
      const a = setting.authSetting || {};
      this.log('当前授权: bluetooth=' + a['scope.bluetooth'] + ' userLocation=' + a['scope.userLocation'], 'info');
    } catch (e) {
      this.log('getSetting 失败: ' + (e && e.errMsg), 'error');
    }

    // 依次主动请求两个 scope
    const scopes = [
      { key: 'scope.bluetooth',    label: '蓝牙' },
      { key: 'scope.userLocation', label: '定位（Android 扫描必须）' }
    ];
    let anyFail = false;
    for (const s of scopes) {
      try {
        await new Promise((res, rej) => wx.authorize({ scope: s.key, success: res, fail: rej }));
        this.log(s.label + ' 授权成功', 'info');
      } catch (e) {
        const msg = (e && e.errMsg) || '';
        this.log(s.label + ' 授权失败: ' + msg, 'warn');
        anyFail = true;
      }
    }

    if (anyFail) {
      // 显示「去设置」按钮（open-type="openSetting"），不直接调 wx.openSetting
      // 因为 wx.openSetting 在手势上下文丢失时会静默失败
      this.log('部分权限授权失败，请点击下方「去设置」按钮手动开启', 'warn');
      this.setData({ showOpenSetting: true });
    } else {
      // 全部成功，直接重新初始化
      this._tryInit();
    }
  },

  // 从设置页返回后触发（<button open-type="openSetting"> 的 bindopensetting 事件）
  onSettingReturn(e) {
    const auth = (e.detail && e.detail.authSetting) || {};
    this.log('设置页返回: bluetooth=' + auth['scope.bluetooth'] + ' userLocation=' + auth['scope.userLocation'], 'info');
    this.setData({ showOpenSetting: false });
    // 重新初始化 BLE
    this._tryInit();
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
