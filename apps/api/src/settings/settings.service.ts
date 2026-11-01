import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ztteam_getStorageRoot } from '../common/ztteam_storage.util';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class ZTTeamSettingsService {
  private readonly logger = new Logger(ZTTeamSettingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async ztteam_getSettings() {
    const records = await this.prisma.ztteam_settings.findMany();
    const settings: Record<string, string> = {};
    for (const r of records) {
      settings[r.key] = r.value;
    }
    return settings;
  }

  async ztteam_updateSettings(data: Record<string, string>) {
    const keys = Object.keys(data);
    for (const key of keys) {
      await this.prisma.ztteam_settings.upsert({
        where: { key },
        update: { value: String(data[key] ?? '') },
        create: { key, value: String(data[key] ?? '') },
      });
    }

    if (data['youtube_cookies'] !== undefined) {
      try {
        const cookiesPath = path.join(ztteam_getStorageRoot(), 'cookies.txt');
        fs.writeFileSync(cookiesPath, data['youtube_cookies'] || '', 'utf-8');
        this.logger.log(`Updated youtube cookies.txt file at ${cookiesPath}`);
      } catch (e: any) {
        this.logger.error(`Error saving youtube_cookies file: ${e.message}`);
      }
    }

    return { success: true };
  }

  /**
   * ZTTeam: Kiểm tra trực tiếp thông số, độ trễ và hạn ngạch của các Provider AI
   */
  async ztteam_getAiHealth() {
    const settings = await this.ztteam_getSettings();
    const result: any = {
      activeProvider: settings['active_ai_provider'] || 'gemini',
      gemini: { status: 'NOT_CONFIGURED', latencyMs: 0, model: 'gemini-3.5-flash-lite', quotaTier: 'Free Tier (500 req/ngày)', message: 'Chưa cấu hình API Key' },
      openai: { status: 'NOT_CONFIGURED', latencyMs: 0, model: 'gpt-4o-mini', message: 'Chưa cấu hình API Key' }
    };

    /** 1. Kiểm tra Google Gemini */
    const geminiKey = settings['gemini_api_key'] || process.env.GEMINI_API_KEY;
    if (geminiKey) {
      try {
        const { GoogleGenerativeAI } = require('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(geminiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash-lite' });
        const t0 = Date.now();
        const res = await model.generateContent('ping');
        const latencyMs = Date.now() - t0;
        result.gemini = {
          status: 'HEALTHY',
          latencyMs,
          model: 'gemini-3.5-flash-lite',
          quotaTier: 'Free Tier (500 req/ngày)',
          message: 'Kết nối ổn định, sẵn sàng xử lý'
        };
      } catch (err: any) {
        const msg = err.message || '';
        const is429 = msg.includes('429') || msg.includes('Quota exceeded') || msg.includes('RESOURCE_EXHAUSTED');
        result.gemini = {
          status: is429 ? 'QUOTA_EXCEEDED' : 'ERROR',
          latencyMs: 0,
          model: 'gemini-3.5-flash-lite',
          quotaTier: 'Free Tier (500 req/ngày)',
          message: is429 ? 'Đã chạm hạn ngạch 500 req/ngày của Google Free Tier. Đang chờ reset hoặc tự động chuyển sang OpenAI.' : msg
        };
      }
    }

    /** 2. Kiểm tra OpenAI */
    const openaiKey = settings['openai_api_key'] || process.env.OPENAI_API_KEY;
    if (openaiKey) {
      try {
        const OpenAI = require('openai').default;
        const openai = new OpenAI({ apiKey: openaiKey });
        const t0 = Date.now();
        const res = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 5,
        });
        const latencyMs = Date.now() - t0;
        result.openai = {
          status: 'HEALTHY',
          latencyMs,
          model: 'gpt-4o-mini',
          message: 'Kết nối ổn định, sẵn sàng dự phòng'
        };
      } catch (err: any) {
        result.openai = {
          status: 'ERROR',
          latencyMs: 0,
          model: 'gpt-4o-mini',
          message: err.message || 'Lỗi kết nối OpenAI'
        };
      }
    }

    return result;
  }
}
