/**
 * Google Scholar搜索器 - 网页抓取实现
 * 基于HTML解析，包含反检测机制、会话管理和代理支持
 */

import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import * as cheerio from 'cheerio';
import { Paper, PaperFactory } from '../models/Paper.js';
import { PaperSource, SearchOptions, DownloadOptions, PlatformCapabilities } from './PaperSource.js';
import { TIMEOUTS } from '../config/constants.js';
import { logDebug } from '../utils/Logger.js';

const execFileAsync = promisify(execFile);

interface GoogleScholarOptions extends SearchOptions {
  /** 语言设置 */
  language?: string;
  /** 时间范围（年份） */
  yearLow?: number;
  yearHigh?: number;
}

export class GoogleScholarSearcher extends PaperSource {
  private readonly scholarUrl = 'https://scholar.google.com/scholar';
  private readonly userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'
  ];
  private sessionCookies: string = '';
  private lastRequestTime: number = 0;
  private consecutiveFailures: number = 0;
  private readonly maxRetries = 3;
  private readonly baseDelay = 3000;
  // Proxy for Google Scholar access. Priority: SCHOLAR_PROXY > HTTPS_PROXY > HTTP_PROXY,
  // falling back to the host's configured proxy (127.0.0.1:7897), since scholar.google.com
  // is typically only reachable through the local proxy on this machine.
  private readonly proxy: string | undefined =
    process.env.SCHOLAR_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || this.detectSystemProxy();

  constructor() {
    super('google_scholar', 'https://scholar.google.com');
    if (this.proxy) {
      logDebug(`Google Scholar using proxy: ${this.proxy.split('@').pop()}`);
    }
  }

  getCapabilities(): PlatformCapabilities {
    return {
      search: true,
      download: false,
      fullText: false,
      citations: true,
      requiresApiKey: false,
      supportedOptions: ['maxResults', 'year', 'author']
    };
  }

  /**
   * 搜索Google Scholar论文
   */
  async search(query: string, options: GoogleScholarOptions = {}): Promise<Paper[]> {
    logDebug(`Google Scholar Search: query="${query}"`);

    try {
      await this.initializeSession();

      const papers: Paper[] = [];
      let start = 0;
      const resultsPerPage = 10;
      const maxResults = Math.min(options.maxResults || 10, 20);

      while (papers.length < maxResults) {
        await this.adaptiveDelay();

        const params = this.buildSearchParams(query, start, options);
        const response = await this.retryRequest(params);

        if (response.status === 429 || response.status === 403) {
          logDebug(`Google Scholar rate limited (HTTP ${response.status}), resetting session...`);
          this.consecutiveFailures++;
          if (this.consecutiveFailures >= this.maxRetries) {
            throw new Error('Google Scholar search blocked after multiple retries. Please try again later or use a different platform.');
          }
          await this.resetSession();
          continue;
        }

        if (response.status !== 200) {
          logDebug(`Google Scholar HTTP Error: ${response.status}`);
          break;
        }

        if (response.data.includes('recaptcha') || response.data.includes('captcha') ||
            response.data.includes('Sorry, we can\'t verify that you\'re not a robot')) {
          logDebug('Google Scholar captcha detected');
          this.consecutiveFailures++;
          if (this.consecutiveFailures >= this.maxRetries) {
            throw new Error('Google Scholar requires captcha verification. Please try again later or use a different platform.');
          }
          await this.resetSession();
          continue;
        }

        this.consecutiveFailures = 0;

        const $ = cheerio.load(response.data);
        const results = $('.gs_ri');

        if (results.length === 0) {
          logDebug('Google Scholar: No more results found');
          break;
        }

        logDebug(`Google Scholar: Found ${results.length} results on page`);

        results.each((index, element) => {
          if (papers.length >= maxResults) return false;

          const paper = this.parseScholarResult($, $(element));
          if (paper) {
            papers.push(paper);
          }
        });

        start += resultsPerPage;
      }

      logDebug(`Google Scholar Results: Found ${papers.length} papers`);
      return papers;

    } catch (error) {
      this.handleHttpError(error, 'search');
    }
  }

  /**
   * 初始化会话 - 先访问主页获取cookie
   */
  private async initializeSession(): Promise<void> {
    try {
      const userAgent = this.getRandomUserAgent();
      const result = await this.runCurl('https://scholar.google.com', {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }, userAgent, true);

      // Extract Set-Cookie headers from the raw header block
      const setCookie = result.rawHeaders.match(/^Set-Cookie:\s*(.*)$/gmi) || [];
      if (setCookie.length > 0) {
        this.sessionCookies = setCookie
          .map(c => c.replace(/^Set-Cookie:\s*/i, '').split(';')[0].trim())
          .filter(c => c.length > 0)
          .join('; ');
        logDebug('Google Scholar session initialized');
      }
    } catch (error: any) {
      logDebug('Failed to initialize Google Scholar session, continuing without cookies');
    }
  }

  /**
   * 重置会话
   */
  private async resetSession(): Promise<void> {
    this.sessionCookies = '';
    await this.randomDelay(5000, 10000);
    await this.initializeSession();
  }

  /**
   * Google Scholar不支持直接PDF下载
   */
  async downloadPdf(paperId: string, options?: DownloadOptions): Promise<string> {
    throw new Error('Google Scholar does not support direct PDF download. Please use the paper URL to access the publisher.');
  }

  /**
   * Google Scholar不提供全文内容
   */
  async readPaper(paperId: string, options?: DownloadOptions): Promise<string> {
    throw new Error('Google Scholar does not provide full-text content. Please use the paper URL to access the full text.');
  }

  /**
   * 构建搜索参数
   */
  private buildSearchParams(query: string, start: number, options: GoogleScholarOptions): Record<string, any> {
    const params: Record<string, any> = {
      q: query,
      start: start,
      hl: options.language || 'en',
      as_sdt: '0,5',
      as_vis: '1'
    };

    if (options.yearLow || options.yearHigh) {
      params.as_ylo = options.yearLow || '';
      params.as_yhi = options.yearHigh || '';
    }

    if (options.author) {
      params.as_sauthors = options.author;
    }

    return params;
  }

  /**
   * 发起Scholar请求（不自动重试，由search方法控制重试逻辑）
   */
  private async makeScholarRequest(params: Record<string, any>): Promise<{ status: number; data: string; rawHeaders: string }> {
    const userAgent = this.getRandomUserAgent();

    const queryString = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== '')
    ).toString();

    const headers: Record<string, string> = {
      'User-Agent': userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'DNT': '1'
    };

    if (this.sessionCookies) {
      headers['Cookie'] = this.sessionCookies;
    }

    const url = `${this.scholarUrl}?${queryString}`;
    logDebug(`Google Scholar Request: GET ${url}`);

    return await this.runCurl(url, headers, userAgent, false);
  }

  /**
   * 带重试地发送一次 Scholar 请求。针对代理链路抖动（TLS 握手失败、空响应）做容错。
   * 仅对网络异常（抛错）和"HTTP 200 但 body 为空"重试；HTTP 业务状态码（302/403/429 等）
   * 直接返回给 search 方法处理，避免在限流等状态上盲目重试。
   */
  private async retryRequest(params: Record<string, any>): Promise<{ status: number; data: string; rawHeaders: string }> {
    let lastError: string = '';
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await this.makeScholarRequest(params);
        const hasBody = response.data && response.data.trim().length > 0;
        // 200 且有内容 => 成功；其它状态码 => 交给 search 处理
        if (response.status !== 200 || hasBody) {
          return response;
        }
        lastError = 'empty response body';
        logDebug(`Google Scholar empty response, retry ${attempt + 1}/${this.maxRetries}`);
        await this.randomDelay(3000, 6000);
      } catch (error: any) {
        lastError = error.message || String(error);
        logDebug(`Google Scholar request error, retry ${attempt + 1}/${this.maxRetries}: ${lastError}`);
        await this.randomDelay(3000, 6000);
      }
    }
    throw new Error(`Google Scholar request failed after ${this.maxRetries} attempts: ${lastError}`);
  }

  /**
   * 通过系统 curl 发起请求。Google Scholar 对 Node 默认 TLS 指纹会限流（429），
   * 而 curl 的指纹更接近普通客户端，实测走代理可稳定返回 200 + 真实结果。
   * @returns { status, data, rawHeaders } — data 为页面 HTML，rawHeaders 仅在 captureHeaders 时非空
   */
  private async runCurl(
    url: string,
    headers: Record<string, string>,
    userAgent: string,
    captureHeaders: boolean
  ): Promise<{ status: number; data: string; rawHeaders: string }> {
    const headersWithUA: Record<string, string> = { 'User-Agent': userAgent, ...headers };

    const args: string[] = ['-sS', '-L', '--compressed', '--max-time', String(Math.floor(TIMEOUTS.DEFAULT / 1000))];
    if (this.proxy) {
      args.push('-x', this.proxy.replace(/^https?:\/\//, ''));
    }
    for (const [k, v] of Object.entries(headersWithUA)) {
      args.push('-H', `${k}: ${v}`);
    }

    if (captureHeaders) {
      // 响应头输出到 stdout，body 丢弃
      const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
      args.push('-D', '-', '-o', nullDevice, url);
      const { stdout } = await execFileAsync('curl', args, { windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
      const status = this.parseStatusFromHeaders(stdout);
      return { status, data: '', rawHeaders: stdout };
    }

    // body 输出到 stdout，末尾追加状态码标记
    args.push('-w', '\n__GS_STATUS__%{http_code}', url);
    const { stdout } = await execFileAsync('curl', args, { windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
    const m = stdout.match(/__GS_STATUS__(\d+)\s*$/);
    const status = m ? parseInt(m[1], 10) : 0;
    const data = stdout.replace(/__GS_STATUS__\d+\s*$/, '');
    return { status, data, rawHeaders: '' };
  }

  /**
   * 从 curl -D 输出的原始响应头中解析状态码
   */
  private parseStatusFromHeaders(rawHeaders: string): number {
    const m = rawHeaders.match(/^HTTP\/\S*\s+(\d{3})/im);
    return m ? parseInt(m[1], 10) : 0;
  }

  /**
   * 探测系统配置的代理（Windows 注册表 Internet Settings），回退到常见本地代理端口
   */
  private detectSystemProxy(): string | undefined {
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyServer'], { encoding: 'utf8', windowsHide: true });
      const m = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
      if (m) {
        const server = m[1].trim();
        return server.startsWith('http') ? server : `http://${server}`;
      }
    } catch {
      // ignore
    }
    // 常见本地代理端口，作为最后回退
    return 'http://127.0.0.1:7897';
  }

  /**
   * 解析单个Scholar搜索结果
   */
  private parseScholarResult($: cheerio.CheerioAPI, element: cheerio.Cheerio<any>): Paper | null {
    try {
      const titleElement = element.find('h3.gs_rt');
      const titleLink = titleElement.find('a');
      const title = titleElement.text().replace(/^\[PDF\]|\[HTML\]|\[BOOK\]|\[B\]/, '').trim();
      const url = titleLink.attr('href') || '';

      if (!title) {
        return null;
      }

      const titleText = titleElement.text();
      if (titleText.includes('[BOOK]') || titleText.includes('[B]') ||
          url.includes('books.google.com')) {
        return null;
      }

      const infoElement = element.find('div.gs_a');
      const infoText = infoElement.text();
      const authors = this.extractAuthors(infoText);
      const year = this.extractYear(infoText);

      const abstractElement = element.find('div.gs_rs');
      const abstract = abstractElement.text() || '';

      const citationElement = element.find('div.gs_fl a').filter((i, el) => {
        return $(el).text().includes('Cited by');
      });
      const citationText = citationElement.text();
      const citationCount = this.extractCitationCount(citationText);

      const paperId = this.generatePaperId(title, authors);

      return PaperFactory.create({
        paperId,
        title: this.cleanText(title),
        authors,
        abstract: this.cleanText(abstract),
        doi: '',
        publishedDate: year ? new Date(year, 0, 1) : null,
        pdfUrl: '',
        url,
        source: 'googlescholar',
        categories: [],
        keywords: [],
        citationCount,
        journal: this.extractJournal(infoText),
        year,
        extra: {
          scholarId: paperId,
          infoText
        }
      });
    } catch (error) {
      logDebug('Error parsing Google Scholar result:', error);
      return null;
    }
  }

  /**
   * 提取作者信息
   */
  private extractAuthors(infoText: string): string[] {
    const parts = infoText.split(' - ');
    if (parts.length > 0) {
      const authorPart = parts[0];
      return authorPart.split(',').map(author => author.trim()).filter(a => a.length > 0);
    }
    return [];
  }

  /**
   * 提取年份
   */
  private extractYear(text: string): number | undefined {
    const yearMatch = text.match(/\b(19|20)\d{2}\b/);
    return yearMatch ? parseInt(yearMatch[0], 10) : undefined;
  }

  /**
   * 提取期刊信息
   */
  private extractJournal(infoText: string): string {
    const parts = infoText.split(' - ');
    if (parts.length > 1) {
      return parts[1].split(',')[0].trim();
    }
    return '';
  }

  /**
   * 提取引用次数
   */
  private extractCitationCount(citationText: string): number {
    const match = citationText.match(/Cited by (\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  }

  /**
   * 生成论文ID
   */
  private generatePaperId(title: string, authors: string[]): string {
    const titleHash = this.simpleHash(title);
    const authorHash = this.simpleHash(authors.join(''));
    return `gs_${titleHash}_${authorHash}`;
  }

  /**
   * 简单哈希函数
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * 获取随机User-Agent
   */
  private getRandomUserAgent(): string {
    return this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
  }

  /**
   * 自适应延迟 - 根据请求间隔动态调整
   */
  private async adaptiveDelay(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    const minDelay = this.baseDelay + this.consecutiveFailures * 2000;

    if (timeSinceLastRequest < minDelay) {
      const waitTime = minDelay - timeSinceLastRequest + Math.random() * 2000;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    } else {
      await new Promise(resolve => setTimeout(resolve, Math.random() * 1000));
    }

    this.lastRequestTime = Date.now();
  }

  /**
   * 随机延迟
   */
  private async randomDelay(min: number = 1000, max: number = 3000): Promise<void> {
    const delay = Math.random() * (max - min) + min;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}
