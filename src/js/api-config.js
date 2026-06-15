/**
 * api-config.js — API 配置管理模块
 * 管理 LLM API 连接配置（DeepSeek 兼容格式）
 *
 * 与 user-preferences.js 相同的持久化模式：
 * - JSON 文件存储在 data/ 目录
 * - get() 暴露给前端（隐藏敏感信息）
 * - getFull() 暴露给后端引擎（含完整 key）
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

class ApiConfig {
  constructor(dataDir) {
    this.configFile = path.join(dataDir, 'api-config.json');
    this.config = null;
  }

  /**
   * 初始化：加载或创建默认配置
   */
  init() {
    this.config = this._loadJSON({
      enabled: false,                      // API 模式开关
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      apiKey: '',
      model: 'deepseek-chat',
      temperature: 0.8,
      maxTokens: 400,
    });
    return this;
  }

  /**
   * 给前端用的（隐藏 key 敏感信息）
   */
  get() {
    return {
      ...this.config,
      apiKey: this.config.apiKey ? '••••••••' : '',
    };
  }

  /**
   * 给后端引擎用的（含完整 key）
   */
  getFull() {
    return { ...this.config };
  }

  /**
   * 更新配置并持久化
   */
  update(config) {
    // 如果传了 apiKey 且不是脱敏字符串，更新；否则保留原值
    if (config.apiKey && config.apiKey !== '••••••••') {
      this.config.apiKey = config.apiKey;
    }
    this.config.enabled = config.enabled !== undefined ? config.enabled : this.config.enabled;
    this.config.endpoint = config.endpoint || this.config.endpoint;
    this.config.model = config.model || this.config.model;
    if (config.temperature !== undefined) this.config.temperature = config.temperature;
    if (config.maxTokens !== undefined) this.config.maxTokens = config.maxTokens;
    this._save();
  }

  // ============================================================
  // 持久化
  // ============================================================

  _loadJSON(defaults) {
    try {
      if (fs.existsSync(this.configFile)) {
        return { ...defaults, ...JSON.parse(fs.readFileSync(this.configFile, 'utf-8')) };
      }
    } catch (e) {
      // ignore corrupted file, use defaults
    }
    this._saveJSON(this.configFile, defaults);
    return { ...defaults };
  }

  _save() {
    this._saveJSON(this.configFile, this.config);
  }

  _saveJSON(filePath, data) {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
      console.error('Failed to save api-config:', e);
    }
  }

  // ============================================================
  // LLM API 调用
  // ============================================================

  /**
   * Call the LLM API with OpenAI-compatible chat completions format.
   * DeepSeek, OpenAI, and most LLM providers support this format.
   *
   * @param {Array} messages - 消息数组 [{ role, content }, ...]
   * @returns {string|null} 回复文本，失败返回 null
   */
  async callChatCompletion(messages) {
    if (!this.config.enabled || !this.config.apiKey) return null;

    const body = JSON.stringify({
      model: this.config.model,
      messages: messages,
      temperature: this.config.temperature,
      max_tokens: this.config.maxTokens,
    });

    try {
      const response = await this._httpsPost(this.config.endpoint, body, {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      });
      if (response?.choices?.[0]?.message?.content) {
        return response.choices[0].message.content.trim();
      }
      return null;
    } catch (e) {
      console.error('API call failed:', e.message);
      return null;
    }
  }

  /**
   * 发起 HTTPS POST 请求
   */
  _httpsPost(url, body, headers) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 15000,
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
      });
      req.on('error', (e) => reject(e));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('timeout'));
      });
      req.write(body);
      req.end();
    });
  }
}

module.exports = ApiConfig;
