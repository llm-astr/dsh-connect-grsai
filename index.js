import z from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client';
import { tools, run } from './video-core.js';
export const name = 'grsai-video';
export const inject = ['tools'];
export const Config = z.object({
  apiKey: z.string().role('secret').default('').description('GrsAI API Key：不回显原值，保存在本机 profile 配置，并非加密保险库。').volatile(),
  workspace: z.string().default(join(homedir(), 'dshwork')).description('本地参考图片和音频的工作区绝对路径。').volatile(),
  region: z.union(['global', 'china']).default('global').description('GrsAI 全球或国内节点。任务查询应与提交使用相同节点。').volatile(),
});
export function apply(ctx, config) {
  for (const tool of tools) {
    const definition = createMcpToolDefinition(ctx, {
      name: `mcp__grsai_video__${tool.name}`, rawName: tool.name,
      description: tool.description, inputSchema: tool.inputSchema,
      async call(args, exec) {
        try {
          const workspace = config.workspace.get();
          if (!isAbsolute(workspace)) throw new Error('请在插件配置填写工作区绝对路径。');
          return await run(tool.name, args, {
            apiKey: config.apiKey.get(), workspace, region: config.region.get(), signal: exec.signal,
            async approve(request) {
              const approval = ctx.get('approval');
              if (!approval || !exec.agent) return false;
              const outcome = await approval.request({
                agent: exec.agent, toolName: `mcp__grsai_video__${tool.name}`, signal: exec.signal,
                reason: `GrsAI 付费视频提交：${request.model}，${request.duration}秒，${request.resolution}，比例${request.aspectRatio}。仅本次提交，不自动重试。参数与参考素材：${JSON.stringify(request)}`,
              });
              return outcome === 'allowed-once';
            },
          });
        } catch (error) {
          return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : '视频操作失败，未自动重试。' }] };
        }
      },
    });
    definition.timeoutMs = 660000;
    ctx.effect(() => ctx.tools.register(definition));
  }
}
