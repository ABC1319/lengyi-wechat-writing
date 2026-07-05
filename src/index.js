/**
 * lengyi-wechat-writing - Cloudflare Workers 版本
 * 微信公众号自动写作工具 - Serverless 后端
 */

import { Router } from 'itty-router';

// ==================== CORS 配置 ====================
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function handleCORS() {
  return new Response(null, { headers: corsHeaders });
}

// ==================== 工具函数 ====================

/**
 * 创建 SSE 响应
 */
function createSSEResponse(readable) {
  return new Response(readable, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

/**
 * 安全解析 JSON
 */
function safeJSONParse(str, defaultVal = null) {
  try {
    return JSON.parse(str);
  } catch {
    return defaultVal;
  }
}

/**
 * 读取请求体
 */
async function readRequestBody(request) {
  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return await request.json();
  }
  return {};
}

// ==================== 内置写作风格 ====================
// 由于 Workers 无法直接读取文件系统，将风格文件内嵌
const BUILTIN_STYLES = {
  '科技媒体评论': `你是一位资深科技媒体评论员，擅长撰写深度科技评论文章。

写作要求：
1. 文章结构：引言 → 背景分析 → 核心观点 → 深度解读 → 总结展望
2. 语言风格：专业但不晦涩，有洞察力，善用类比
3. 每段控制在200字以内，段落间有逻辑递进
4. 适当引用数据和案例支撑观点
5. 结尾要有前瞻性思考，引发读者共鸣

注意事项：
- 不要过度使用专业术语，必要时解释
- 保持客观中立的立场
- 文章字数控制在1500-2000字`,

  '产品评测': `你是一位专业的产品评测编辑，擅长撰写客观、全面的产品评测文章。

写作要求：
1. 文章结构：开箱/初印象 → 外观设计 → 核心功能体验 → 优缺点分析 → 购买建议
2. 语言风格：客观理性，细节丰富，有真实使用感
3. 多用具体数据和场景描述
4. 优缺点要平衡，不吹不黑
5. 结尾给出明确的购买建议和适用人群

注意事项：
- 避免过度营销语言
- 真实体验优先于参数堆砌
- 文章字数控制在1200-1800字`,

  '行业分析': `你是一位资深行业分析师，擅长撰写行业洞察和趋势分析文章。

写作要求：
1. 文章结构：行业现状 → 关键驱动因素 → 竞争格局 → 发展趋势 → 投资建议
2. 语言风格：数据驱动，逻辑严密，观点鲜明
3. 善用图表化描述（用文字描述图表内容）
4. 引用行业数据和权威报告
5. 对未来趋势有独立判断

注意事项：
- 数据来源要可靠
- 区分事实和观点
- 文章字数控制在2000-3000字`,

  '科普解读': `你是一位优秀的科普作家，擅长将复杂的科技概念用通俗易懂的语言解释清楚。

写作要求：
1. 文章结构：现象引入 → 原理解释 → 实际应用 → 未来展望
2. 语言风格：生动有趣，善用比喻和类比
3. 由浅入深，循序渐进
4. 多用生活化案例帮助理解
5. 结尾引发读者思考

注意事项：
- 避免过度简化导致失真
- 关键概念要准确
- 文章字数控制在1500-2500字`,

  '创业故事': `你是一位擅长人物特写的商业记者，善于挖掘创业故事背后的精神内核。

写作要求：
1. 文章结构：人物出场 → 创业缘起 → 关键转折 → 挑战与突破 → 感悟与展望
2. 语言风格：有温度，有细节，有人物弧光
3. 多用对话和场景描写
4. 展现人物的真实情感和决策过程
5. 结尾提炼可借鉴的经验

注意事项：
- 尊重事实，不虚构情节
- 突出人物个性
- 文章字数控制在1800-2500字`,
};

// ==================== 路由 ====================
const router = Router();

// ---------- 健康检查 ----------
router.get('/', () => {
  return new Response(JSON.stringify({
    name: 'lengyi-wechat-writing',
    version: '2.0.0-cloudflare',
    status: 'running',
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});

// ---------- 获取写作风格列表 ----------
router.get('/api/styles', async (request, env) => {
  const styles = Object.keys(BUILTIN_STYLES).map(name => ({
    name,
    description: BUILTIN_STYLES[name].split('\n')[0].replace('你是一位', '').replace('，', ' - '),
  }));

  return new Response(JSON.stringify({ styles }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});

// ---------- SSE 流式生成正文 ----------
router.post('/api/article', async (request, env) => {
  const body = await readRequestBody(request);
  const { topic, style, apiUrl, apiKey, model } = body;

  if (!topic || !apiUrl || !apiKey || !model) {
    return new Response(JSON.stringify({ error: '缺少必要参数: topic, apiUrl, apiKey, model' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const stylePrompt = BUILTIN_STYLES[style] || BUILTIN_STYLES['科技媒体评论'] || '';

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // 异步发送请求并流式返回
  (async () => {
    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model,
          messages: [
            {
              role: 'system',
              content: `${stylePrompt}\n\n请根据用户提供的主题，严格按照上述风格要求撰写文章。`,
            },
            {
              role: 'user',
              content: `主题：${topic}\n\n请开始撰写文章。`,
            },
          ],
          stream: true,
          temperature: 0.7,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        writer.write(encoder.encode(`data: ${JSON.stringify({ error: `AI API 错误: ${response.status} - ${errorText}` })}\n\n`));
        writer.close();
        return;
      }

      const reader = response.body.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = new TextDecoder().decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.trim() === '') continue;
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              writer.write(encoder.encode('data: [DONE]\n\n'));
              continue;
            }
            const parsed = safeJSONParse(data);
            if (parsed && parsed.choices && parsed.choices[0].delta) {
              const content = parsed.choices[0].delta.content || '';
              if (content) {
                writer.write(encoder.encode(`data: ${JSON.stringify({ content })}\n\n`));
              }
            }
          }
        }
      }

      writer.write(encoder.encode('data: [DONE]\n\n'));
    } catch (error) {
      writer.write(encoder.encode(`data: ${JSON.stringify({ error: error.message })}\n\n`));
    } finally {
      writer.close();
    }
  })();

  return createSSEResponse(readable);
});

// ---------- 生成标题和摘要 ----------
router.post('/api/titles', async (request, env) => {
  const body = await readRequestBody(request);
  const { article, apiUrl, apiKey, model } = body;

  if (!article || !apiUrl || !apiKey || !model) {
    return new Response(JSON.stringify({ error: '缺少必要参数' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model,
        messages: [
          {
            role: 'system',
            content: `你是一位专业的内容编辑，擅长为文章撰写吸引人的标题和摘要。

请基于以下文章，生成5组标题和摘要。要求：
1. 标题要吸引眼球，但不做标题党
2. 摘要要准确概括文章核心内容，100字以内
3. 5组标题风格要有差异（如：疑问式、数字式、观点式、故事式、干货式）
4. 以 JSON 数组格式返回，格式如下：
[
  {"title": "标题1", "summary": "摘要1"},
  {"title": "标题2", "summary": "摘要2"},
  ...
]`,
          },
          {
            role: 'user',
            content: `文章正文：\n\n${article}\n\n请生成5组标题和摘要，以JSON格式返回。`,
          },
        ],
        temperature: 0.8,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return new Response(JSON.stringify({ error: `AI API 错误: ${response.status}` }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';

    // 尝试从内容中提取 JSON
    let titles = [];
    try {
      // 尝试直接解析
      titles = JSON.parse(content);
    } catch {
      // 尝试从 markdown 代码块中提取
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        titles = JSON.parse(jsonMatch[1]);
      } else {
        // 尝试从文本中提取 JSON 数组
        const arrayMatch = content.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
          titles = JSON.parse(arrayMatch[0]);
        }
      }
    }

    return new Response(JSON.stringify({ titles }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// ---------- 生成封面 Prompt ----------
router.post('/api/cover/prompts', async (request, env) => {
  const body = await readRequestBody(request);
  const { article, apiUrl, apiKey, model } = body;

  if (!article || !apiUrl || !apiKey || !model) {
    return new Response(JSON.stringify({ error: '缺少必要参数' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model,
        messages: [
          {
            role: 'system',
            content: `你是一位专业的视觉设计师，擅长为文章设计封面图。

请基于文章内容，生成3个封面图 Prompt。要求：
1. Prompt 要简洁有力，突出文章核心主题
2. 风格适合微信公众号封面（16:9 横版）
3. 每个 Prompt 要包含：主体描述、风格、色调、构图
4. 以 JSON 数组格式返回：
[
  {"prompt": "Prompt 1", "description": "简要说明这个封面的设计思路"},
  {"prompt": "Prompt 2", "description": "..."},
  {"prompt": "Prompt 3", "description": "..."}
]`,
          },
          {
            role: 'user',
            content: `文章正文：\n\n${article}\n\n请生成3个封面图 Prompt，以JSON格式返回。`,
          },
        ],
        temperature: 0.8,
      }),
    });

    if (!response.ok) {
      return new Response(JSON.stringify({ error: '生成 Prompt 失败' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';

    let prompts = [];
    try {
      prompts = JSON.parse(content);
    } catch {
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        prompts = JSON.parse(jsonMatch[1]);
      } else {
        const arrayMatch = content.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
          prompts = JSON.parse(arrayMatch[0]);
        }
      }
    }

    return new Response(JSON.stringify({ prompts }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// ---------- 生成封面图 ----------
router.post('/api/cover/generate', async (request, env) => {
  const body = await readRequestBody(request);
  const { prompt, imageApiUrl, imageApiKey, imageModel } = body;

  if (!prompt || !imageApiUrl || !imageApiKey || !imageModel) {
    return new Response(JSON.stringify({ error: '缺少必要参数' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const response = await fetch(imageApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${imageApiKey}`,
      },
      body: JSON.stringify({
        model: imageModel,
        prompt: prompt,
        n: 1,
        size: '1024x576', // 16:9 比例
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return new Response(JSON.stringify({ error: `图片生成失败: ${response.status}` }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const data = await response.json();
    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// ---------- 图片代理（解决跨域）----------
router.get('/api/cover/proxy', async (request) => {
  const url = new URL(request.url).searchParams.get('url');
  if (!url) {
    return new Response('Missing url parameter', { status: 400 });
  }

  try {
    const imageResponse = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0',
      },
    });

    if (!imageResponse.ok) {
      return new Response('Failed to fetch image', { status: 502 });
    }

    const contentType = imageResponse.headers.get('Content-Type') || 'image/png';
    const blob = await imageResponse.blob();

    return new Response(blob, {
      headers: {
        ...corsHeaders,
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (error) {
    return new Response(`Proxy error: ${error.message}`, { status: 500 });
  }
});

// ---------- 图片下载代理 ----------
router.post('/api/cover/proxy', async (request) => {
  const body = await readRequestBody(request);
  const { url } = body;

  if (!url) {
    return new Response('Missing url', { status: 400 });
  }

  try {
    const imageResponse = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0',
      },
    });

    if (!imageResponse.ok) {
      return new Response('Failed to fetch image', { status: 502 });
    }

    const contentType = imageResponse.headers.get('Content-Type') || 'image/png';
    const arrayBuffer = await imageResponse.arrayBuffer();

    return new Response(arrayBuffer, {
      headers: {
        ...corsHeaders,
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="cover-${Date.now()}.png"`,
      },
    });
  } catch (error) {
    return new Response(`Proxy error: ${error.message}`, { status: 500 });
  }
});

// ---------- 404 处理 ----------
router.all('*', () => {
  return new Response(JSON.stringify({ error: 'Not Found' }), {
    status: 404,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});

// ==================== 导出 ====================
export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return handleCORS();
    }
    return router.handle(request, env, ctx);
  },
};
