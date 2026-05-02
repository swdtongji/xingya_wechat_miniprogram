// app.js
App({
  globalData: {
    // BLE 协议常量（和 ESP32 端 bluetooth_manager.h 保持一致）
    // 16-bit UUID 0xXXXX 的 128-bit 展开格式为 0000XXXX-0000-1000-8000-00805F9B34FB
    SERVICE_UUID: '000000FF-0000-1000-8000-00805F9B34FB',  // 0x00FF
    WRITE_UUID:   '0000FF01-0000-1000-8000-00805F9B34FB',  // 0xFF01
    NOTIFY_UUID:  '0000FF02-0000-1000-8000-00805F9B34FB',  // 0xFF02
    DEVICE_NAME_PREFIX: 'xingya_',
    // 运行时状态
    deviceId: '',
    connected: false
  },

  onLaunch() {
    // 进入小程序时不自动扫描，由用户主动点击
    console.log('[App] onLaunch');
  },

  onHide() {
    console.log('[App] onHide');
  }
});
