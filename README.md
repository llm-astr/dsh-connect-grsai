# GrsAI Video — DSH 插件

原生 DSH JavaScript 插件，无需 Python、pip 或独立运行时。支持 `minimax-h3` 和 `agnes-video-2.5`，采用异步提交：生成工具只提交一次并返回任务 ID；查询工具每次只查询一次，不忙轮询、不自动重试。

## 安装与配置

通过 DSH「插件 → 添加插件」安装本仓库，然后在插件的 `grsai-video` 配置入口填写 GrsAI API Key、工作区绝对路径及 API 节点。Key 不回显旧值，保存后下次调用生效。隐藏输入不代表加密：Key 保存在本机 profile 配置中，不是系统钥匙串，请勿分享 profile。

全球节点为 `https://grsaiapi.com`；国内节点为 `https://grsai.dakka.com.cn`。已有任务必须使用提交时的节点查询，切换配置只影响后续调用。

## 工具

- `mcp__grsai_video__status`：本地状态，不联网、不显示 Key。
- `mcp__grsai_video__generate_video`：付费视频任务提交，每次必须通过 DSH 一次性审批；固定 `replyType: async`。
- `mcp__grsai_video__get_task`：按 ID 单次查询，不收费提交、不自动轮询；成功结果返回 HTTPS 视频链接。

所有模型、分辨率、时长、比例均要求明确传入，插件不根据比例自行选择清晰度。

### Minimax H3

- `aspect_ratio`: `portrait` / `landscape`
- `resolution`: `480p` / `768p` / `1080p`
- 时长 1–15 秒；1080p 最长 10 秒
- 最多 9 张参考图、3 个参考音频
- 可设置 seed、prompt_skill

### Agnes Video 2.5

- `aspect_ratio`: `16:9` / `9:16` / `21:9` / `4:3` / `1:1` / `3:4`
- `resolution`: `720p` / `1080p` / `2k`
- 时长 4–12 秒
- 最多 5 张参考图、3 个参考音频
- 支持首尾帧；根据官方字段说明，首尾帧模式与普通 images/audios 互斥

参考素材可用 HTTPS URL 或工作区内的本地路径。本地素材会以 base64 字符串提交；该格式由官方文档声明支持，但未进行付费端到端请求验证。

## 安全与测试

请求固定发往所选 GrsAI 官方文档节点，Bearer Key 不进入参数、结果或日志。API 网络错误与错误响应被脱敏；响应有大小限制和超时；不自动重新提交付费任务。任务查询返回的结果只接受无用户名密码的 HTTPS URL。

测试命令：`node --test test-core.js test-client.js`。测试完全 mock fetch，不调用付费 API。

官方文档：
- [Minimax H3](https://qmy27nhsd9.apifox.cn/514679297e0.md)
- [Agnes Video](https://qmy27nhsd9.apifox.cn/523334530e0.md)
- [异步任务查询](https://qmy27nhsd9.apifox.cn/452409577e0.md)
