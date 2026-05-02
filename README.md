# 星芽 BLE 文本输入小程序

通过 BLE 把手机上输入的中文/英文直接发到 ESP32 的 `text_input` 模块（例如 DLC 兑换码、星芽昵称等任何 `allow_bluetooth = true` 的输入场景）。

## 目录结构

```
wechat_miniprogram/
├── app.js                # 小程序入口 + BLE 协议常量
├── app.json              # 页面注册、蓝牙/定位权限声明
├── app.wxss              # 全局样式
├── project.config.json   # 微信开发者工具项目配置
├── sitemap.json
├── pages/
│   └── index/
│       ├── index.js      # 主页面逻辑：扫描 / 连接 / 发送 / 历史 / 日志
│       ├── index.wxml
│       ├── index.wxss
│       └── index.json
└── utils/
    └── ble.js            # BLE 封装：Promise 化、UTF-8 编码、断连监听
```

## 快速开始

### 1. 导入工程

1. 打开 **微信开发者工具** (https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)
2. 左上角「+」→ 「导入项目」
3. 目录选到本文件夹（`main/wechat_miniprogram/`）
4. AppID 可选：
   - 测试阶段：「测试号」(touristappid)
   - 真机调试：注册一个 AppID（https://mp.weixin.qq.com/）

### 2. 真机预览

> ⚠️ BLE 功能在**开发者工具模拟器上不能运行**，必须用真机预览。

1. 点击右上角「预览」生成二维码
2. 微信扫码打开

### 3. 使用流程

1. ESP32 端进入任何支持蓝牙输入的界面（例如 DLC 兑换码），选 `BT` 项
2. 小程序首页 → 「开始扫描」
3. 看到名称以 `xingya_` 开头的设备 → 点击连接
4. 连接成功后进入「输入文本」页
5. 输入内容 → 「发送」
6. ESP32 端自动接收并退出输入界面

## BLE 协议（和 ESP32 端保持一致）

| 项 | 值 |
|---|---|
| 设备名前缀 | `xingya_` |
| Service UUID | `0000FF00-0000-1000-8000-00805F9B34FB` |
| Write Characteristic | `0000FF01-0000-1000-8000-00805F9B34FB` |
| Notify Characteristic | `0000FF02-0000-1000-8000-00805F9B34FB`（预留，暂未启用） |
| 写入方式 | Write with Response |
| MTU | 协商 247（手机决定） |
| 单次最大写入 | 240 字节 UTF-8（约 80 汉字） |
| 编码 | UTF-8，**无长度前缀、无分包头**，直写直收 |

## 常见问题

### 扫描不到设备？
- 确认 ESP32 已进入 `BT 等待` 状态（屏幕上提示 `Waiting phone...`）
- 检查小程序是否授予了**定位权限**（Android 扫 BLE 必须，在系统设置里开）
- 靠近 ESP32（1 米以内）

### 连接失败 / 10008 错误？
- 手机之前在**系统蓝牙设置**里"配对"过该设备 → 先"忽略/取消配对"
- 关闭再打开手机蓝牙

### 发送失败 / 10007 错误？
- 手机 BLE 连接已掉 → 点「断开连接」重连
- 设备重启了 → 重新扫描

### 中文发过去是乱码？
- ESP32 端显示用的字体必须包含对应汉字字形，默认的 `jiyinghuipianheyuan` 字体可能缺字
- 如果需要全中文显示，考虑换成 LVGL `source_han_sans` 或自行用 `LVGL Font Converter` 制作字模

### iOS 上 `setBLEMTU` 报错？
- 正常现象，iOS 系统会自己协商，该 API 调用可以失败但**不影响**通信

## 扩展

### 让 ESP32 主动回消息到手机
- 在 ESP32 端：用 `bluetooth_manager_notify_sync_state(...)` 通过 `0xFF02` 发送
- 在小程序端：调用 `ble.enableNotify(onData)` 注册回调

### 支持更多快捷短语
- 编辑 `pages/index/index.js` 的 `presets` 数组

### 打包给别人用
- 在微信公众平台注册个人/企业小程序 AppID
- 用开发者工具「上传」→ 在管理后台「提交审核」→ 审核通过后「发布」
- 别人可以直接扫码打开，无需安装
