import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';

import { PrismaService } from '../prisma/prisma.service';

export interface ZTTeamColdCaseResult {
  topLabel: string;
  hookHeadline: string;
  yellowBanner: string;
  body: string;
  ending: string;
  commentText: string;
  hashtags: string[];
  fullCaption: string;
  videoBodyHtml: string;
  paragraphs: string[];
}

/**
 * ZTTeamAIService — Provider adapter for AI text generation.
 * Currently supports OpenAI GPT. Expandable to Claude/Gemini via env config.
 */
@Injectable()
export class ZTTeamAIService {
  private readonly logger = new Logger('ZTTeamAIService');

  constructor(private readonly prisma: PrismaService) { }

  private async getSettings() {
    const records = await this.prisma.ztteam_settings.findMany({
      where: {
        key: {
          in: [
            'active_ai_provider',
            'openai_api_key',
            'deepseek_api_key',
            'gemini_api_key',
          ]
        }
      }
    });
    const settings: Record<string, string> = {};
    records.forEach(r => settings[r.key] = r.value);

    return {
      activeProvider: settings['active_ai_provider'] || 'openai',
      openaiKey: settings['openai_api_key'] || process.env.OPENAI_API_KEY,
      deepseekKey: settings['deepseek_api_key'] || process.env.DEEPSEEK_API_KEY,
      geminiKey: settings['gemini_api_key'] || process.env.GEMINI_API_KEY,
    };
  }

  /**
   * ZTTeam: Gọi Gemini API với cơ chế tự động thử lại và Fallback model chống lỗi 503 High Demand
   */
  private async ztteam_callGeminiWithFallback(
    geminiKey: string,
    prompt: string,
    options?: { jsonMode?: boolean; temperature?: number; maxTokens?: number }
  ): Promise<string> {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(geminiKey);

    const modelsToTry = ['gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.1-flash-lite'];
    let lastError: any = null;

    for (const modelName of modelsToTry) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: {
            temperature: options?.temperature ?? 0.75,
            maxOutputTokens: options?.maxTokens,
            ...(options?.jsonMode ? { responseMimeType: 'application/json' } : {})
          }
        });
        const result = await model.generateContent(prompt);
        return result.response.text();
      } catch (err: any) {
        lastError = err;
        this.logger.warn(`Gemini model ${modelName} gặp lỗi (${err.message}), đang thử model dự phòng...`);
        /** Nghỉ 1 giây trước khi thử model tiếp theo */
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    throw lastError;
  }

  /**
   * Generate a simple short caption for YouTube videos
   */
  async ztteam_generateShortCaption(promptText: string): Promise<string> {
    const settings = await this.getSettings();
    if (!settings.openaiKey && !settings.deepseekKey && !settings.geminiKey) {
      this.logger.warn('No API keys found, returning default caption');
      return 'Awesome short video!';
    }
    try {
      if (settings.activeProvider === 'gemini' && settings.geminiKey) {
        const text = await this.ztteam_callGeminiWithFallback(settings.geminiKey, promptText, { temperature: 0.8 });
        return (text || '').trim();
      } else {
        const OpenAI = require('openai').default;
        const isDeepseek = settings.activeProvider === 'deepseek' && settings.deepseekKey;
        const rawKey = isDeepseek ? settings.deepseekKey : settings.openaiKey;
        const apiKey = (rawKey || '').trim();
        const baseURL = isDeepseek ? 'https://api.deepseek.com' : undefined;
        const modelName = isDeepseek ? 'deepseek-chat' : 'gpt-4o-mini';

        if (!apiKey) throw new Error(`Missing API Key for ${settings.activeProvider}`);

        const openai = new OpenAI({ apiKey, baseURL });
        const response = await openai.chat.completions.create({
          model: modelName,
          messages: [
            { role: 'user', content: promptText }
          ],
          max_tokens: 300,
          temperature: 0.8,
        });

        return response.choices[0]?.message?.content?.trim() || 'Awesome short video!';
      }
    } catch (e: any) {
      this.logger.error(`Error generating short caption: ${e.message}`);
      return 'Awesome short video!';
    }
  }

  /**
   * Generate a short reel script (~15 seconds) from a WordPress post.
   * @param postContent - The article text content
   * @param tone - Writing tone (professional, humorous, dramatic, etc.)
   * @param maxWords - Target word count for the script
   * @returns The generated script text
   */
  async ztteam_generateScript(
    postContent: string,
    tone: string = 'professional',
    maxWords: number = 60,
    customPrompt?: string | null,
  ): Promise<{ caption: string; hook: string; sub_voice: string }> {
    this.logger.log(`Generating reel script (tone: ${tone}, maxWords: ${maxWords})`);

    const settings = await this.getSettings();
    if (!settings.openaiKey && !settings.deepseekKey && !settings.geminiKey) {
      this.logger.warn('No API keys found, returning mock script');
      const mockScript = await this.ztteam_getMockScript(postContent);
      return { caption: 'Mock Caption', hook: 'Mock Hook', sub_voice: mockScript };
    }

    const defaultSystemPrompt = `Bạn là chuyên gia viết kịch bản video ngắn (Reel) cho mạng xã hội.
Viết kịch bản giọng đọc cho video ~15 giây dựa trên bài viết người dùng cung cấp.

QUY TẮC TUYỆT ĐỐI CẦN TUÂN THỦ:
- CHỈ VIẾT ĐÚNG ${maxWords} TỪ HOẶC ÍT HƠN. KHÔNG ĐƯỢC VƯỢT QUÁ SỐ TỪ NÀY.
- Giọng văn: ${tone}
- Ngôn ngữ: Tự động viết bằng đúng ngôn ngữ của bài viết gốc (Nếu bài viết bằng tiếng Anh thì viết kịch bản bằng tiếng Anh, nếu bài viết bằng tiếng Việt thì viết kịch bản bằng tiếng Việt).
- Phải có hook mạnh ở câu đầu (gây tò mò)
- Kết thúc bằng CTA ngắn gọn
- KHÔNG dùng emoji, hashtag, hay kí tự đặc biệt trong kịch bản giọng đọc`;

    const systemPrompt = customPrompt ? customPrompt : defaultSystemPrompt;
    const promptWithRules = `${systemPrompt}

BẮT BUỘC TRẢ VỀ DẠNG KẾT QUẢ ĐÚNG THEO ĐỊNH DẠNG JSON SAU (KHÔNG KÈM THEO BẤT KỲ VĂN BẢN NGOÀI NÀO):
{
  "caption": "Trạng thái bài đăng mạng xã hội (kèm hashtag nếu phù hợp)",
  "hook": "Tiêu đề ngắn gây chú ý hiển thị trên video",
  "sub_voice": "Kịch bản đọc voiceover hoàn chỉnh"
}`;

    const userContent = `Generate Reel content from the following article:\n\n${postContent.substring(0, 2000)}`;

    try {
      if (settings.activeProvider === 'gemini' && settings.geminiKey) {
        const text = await this.ztteam_callGeminiWithFallback(
          settings.geminiKey,
          `${promptWithRules}\n\n${userContent}`,
          { jsonMode: true, temperature: 0.8, maxTokens: Math.max(2000, Math.round(maxWords * 8)) }
        );
        const jsonResult = this.ztteam_safeParseJson(text);
        return {
          caption: jsonResult.caption || '',
          hook: jsonResult.hook || '',
          sub_voice: jsonResult.sub_voice || ''
        };
      } else {
        /** Fallback or explicit choice for OpenAI / Deepseek */
        const isDeepseek = settings.activeProvider === 'deepseek' && settings.deepseekKey;
        const rawKey = isDeepseek ? settings.deepseekKey : settings.openaiKey;
        const apiKey = (rawKey || '').trim();
        const baseURL = isDeepseek ? 'https://api.deepseek.com' : undefined;
        const modelName = isDeepseek ? 'deepseek-chat' : 'gpt-4o-mini';

        if (!apiKey) throw new Error(`Missing API Key for ${settings.activeProvider}`);

        const openai = new OpenAI({ apiKey, baseURL });
        const response = await openai.chat.completions.create({
          model: modelName,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: promptWithRules },
            { role: 'user', content: userContent },
          ],
          max_tokens: Math.max(2000, Math.round(maxWords * 8)),
          temperature: 0.8,
        });

        const resultString = response.choices[0]?.message?.content?.trim() || '{}';
        const result = this.ztteam_safeParseJson(resultString);

        this.logger.log(`Script generated: Hook="${result.hook}"`);
        return {
          caption: result.caption || '',
          hook: result.hook || '',
          sub_voice: result.sub_voice || ''
        };
      }
    } catch (error: any) {
      this.logger.error(`AI script generation failed: ${error.message}`);
      throw new Error('Lỗi tạo kịch bản AI: ' + error.message);
    }
  }

  /**
   * Safe JSON Parser & Repair Helper
   * Cleans markdown blocks, repairs unclosed quotes/braces, and extracts fields via Regex fallback if JSON is truncated
   */
  private ztteam_safeParseJson(rawText: string): any {
    if (!rawText || !rawText.trim()) return {};

    /** 1. Strip markdown code fences if present */
    let cleanText = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();

    /** 2. Attempt standard JSON.parse */
    try {
      return JSON.parse(cleanText);
    } catch (e1) {
      this.logger.warn(`Initial JSON parse failed: ${(e1 as Error).message}. Attempting repair...`);
    }

    /** 3. Attempt to repair truncated JSON (append closing quote and brace if cut off) */
    const repairAttempts = [
      cleanText + '"}' ,
      cleanText + '}' ,
      cleanText + '"}]' ,
      cleanText + '}]' ,
    ];

    for (const attempt of repairAttempts) {
      try {
        return JSON.parse(attempt);
      } catch (e2) {
        /** continue trying */
      }
    }

    /** 4. Regex fallback extraction for caption, hook, sub_voice, comment */
    this.logger.warn('JSON repair failed. Using regex extraction fallback...');
    const result: Record<string, string> = {};

    const captionMatch = cleanText.match(/"caption"\s*:\s*"((?:[^"\\]|\\.)*)"?/s);
    if (captionMatch && captionMatch[1]) {
      result.caption = captionMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
    }

    const hookMatch = cleanText.match(/"hook"\s*:\s*"((?:[^"\\]|\\.)*)"?/s);
    if (hookMatch && hookMatch[1]) {
      result.hook = hookMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
    }

    const voiceMatch = cleanText.match(/"sub_voice"\s*:\s*"((?:[^"\\]|\\.)*)"?/s);
    if (voiceMatch && voiceMatch[1]) {
      result.sub_voice = voiceMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
    }

    const commentMatch = cleanText.match(/"comment"\s*:\s*"((?:[^"\\]|\\.)*)"?/s);
    if (commentMatch && commentMatch[1]) {
      result.comment = commentMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
    }

    return result;
  }

  /**
   * Generate an AI caption and first comment for an image post based on a WordPress article.
   */
  async ztteam_generateImageContent(
    postContent: string,
    tone: string = 'professional',
    customPrompt?: string | null,
  ): Promise<{ caption: string; comment: string }> {
    this.logger.log(`Generating image content (tone: ${tone})`);

    const settings = await this.getSettings();
    if (!settings.openaiKey && !settings.deepseekKey && !settings.geminiKey) {
      this.logger.warn('No API keys found, returning mock image content');
      return { caption: 'Mock Caption', comment: 'Mock Comment' };
    }

    const defaultSystemPrompt = `Bạn là chuyên gia viết bài đăng (Post) kèm hình ảnh cho Fanpage mạng xã hội.
Viết một nội dung bài đăng thật thu hút dựa trên bài viết người dùng cung cấp.

QUY TẮC TUYỆT ĐỐI CẦN TUÂN THỦ:
- Giọng văn: ${tone}
- Ngôn ngữ: Tự động viết bằng đúng ngôn ngữ của bài viết gốc (Nếu bài viết bằng tiếng Anh thì viết kịch bản bằng tiếng Anh, nếu bài viết bằng tiếng Việt thì viết kịch bản bằng tiếng Việt).
- Viết 1 tiêu đề (caption) hấp dẫn, ngắn gọn, súc tích, chia đoạn rõ ràng.
- Viết 1 bình luận (comment) để ghim dưới bài viết nhằm kêu gọi tương tác (call to action).
- CÓ THỂ dùng emoji phù hợp.`;

    const systemPrompt = customPrompt ? customPrompt : defaultSystemPrompt;
    const promptWithRules = `${systemPrompt}

BẮT BUỘC TRẢ VỀ DẠNG KẾT QUẢ ĐÚNG THEO ĐỊNH DẠNG JSON SAU (KHÔNG KÈM THEO BẤT KỲ VĂN BẢN NGOÀI NÀO):
{
  "caption": "Nội dung bài đăng kèm ảnh",
  "comment": "Bình luận kêu gọi tương tác để ghim dưới bài viết"
}`;

    const userContent = `Generate Facebook image post content from the following article:\n\n${postContent.substring(0, 2000)}`;

    try {
      if (settings.activeProvider === 'gemini' && settings.geminiKey) {
        const text = await this.ztteam_callGeminiWithFallback(
          settings.geminiKey,
          `${promptWithRules}\n\n${userContent}`,
          { jsonMode: true, temperature: 0.8, maxTokens: 2000 }
        );
        const jsonResult = this.ztteam_safeParseJson(text);
        return {
          caption: jsonResult.caption || '',
          comment: jsonResult.comment || ''
        };
      } else {
        const isDeepseek = settings.activeProvider === 'deepseek' && settings.deepseekKey;
        const rawKey = isDeepseek ? settings.deepseekKey : settings.openaiKey;
        const apiKey = (rawKey || '').trim();
        const baseURL = isDeepseek ? 'https://api.deepseek.com' : undefined;
        const modelName = isDeepseek ? 'deepseek-chat' : 'gpt-4o-mini';

        if (!apiKey) throw new Error(`Missing API Key for ${settings.activeProvider}`);

        const openai = new OpenAI({ apiKey, baseURL });
        const response = await openai.chat.completions.create({
          model: modelName,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: promptWithRules },
            { role: 'user', content: userContent },
          ],
          max_tokens: 2000,
          temperature: 0.8,
        });

        const resultString = response.choices[0]?.message?.content?.trim() || '{}';
        const result = this.ztteam_safeParseJson(resultString);

        return {
          caption: result.caption || '',
          comment: result.comment || ''
        };
      }
    } catch (error: any) {
      this.logger.error(`AI image content generation failed: ${error.message}`);
      throw new Error('Lỗi tạo content AI: ' + error.message);
    }
  }

  /**
   * Generate subtitles with precise timing synchronization.
   * Uses smart chunking (breaks on punctuation like commas and periods)
   * and calculates sentence durations using speech pause weights to match natural TTS audio timing.
   * @param script - Full text script
   * @param audioDuration - Total audio duration in seconds
   * @returns Array of subtitle entries with start, end, and text
   */
  ztteam_generateSubtitles(
    script: string,
    audioDuration: number,
  ): Array<{ start: number; end: number; text: string }> {
    /** Clean text and split into words */
    const cleanedScript = script.replace(/[\n\r]+/g, ' ').replace(/\s+/g, ' ').trim();
    const words = cleanedScript.split(' ').filter(w => w.length > 0);
    
    if (words.length === 0 || audioDuration <= 0) return [];

    const sentences: string[] = [];
    let currentChunk: string[] = [];

    for (const word of words) {
      currentChunk.push(word);
      /** Break chunk if:
       * 1. Reaches 6 words max (ideal for readable short video subtitles)
       * 2. Ends with comma/semicolon/colon when chunk has >= 3 words
       * 3. Ends with period/question/exclamation mark
       */
      const isSentenceEnd = /[.!?。]$/.test(word);
      const isClauseEnd = /[,;:，；:]$/.test(word) && currentChunk.length >= 3;
      const isMaxWords = currentChunk.length >= 6;

      if (isSentenceEnd || isClauseEnd || isMaxWords) {
        sentences.push(currentChunk.join(' '));
        currentChunk = [];
      }
    }
    if (currentChunk.length > 0) {
      sentences.push(currentChunk.join(' '));
    }

    if (sentences.length === 0) return [];

    /** 
     * Calculate speech weight for each sentence chunk:
     * - Base weight: 0.28s per word
     * - Character weight: 0.04s per character
     * - Comma/Clause pause weight: +0.35s
     * - Sentence end pause weight: +0.55s
     */
    const weights = sentences.map(text => {
      const wordCount = text.split(/\s+/).length;
      const charCount = text.length;
      const hasPause = /[,;:，；:]$/.test(text);
      const hasStop = /[.!?。]$/.test(text);

      let weight = (wordCount * 0.28) + (charCount * 0.04);
      if (hasPause) weight += 0.35;
      if (hasStop) weight += 0.55;

      return Math.max(0.6, weight);
    });

    const totalWeight = weights.reduce((sum, w) => sum + w, 0);

    let currentTime = 0;
    
    return sentences.map((text, i) => {
      const sentenceDuration = (weights[i] / totalWeight) * audioDuration;
      
      const start = Math.round(currentTime * 100) / 100;
      const end = Math.round((currentTime + sentenceDuration) * 100) / 100;
      
      currentTime = end;
      
      return { start, end, text: text.trim() };
    });
  }

  /**
   * Generate an ASS subtitle file content from subtitle data.
   * ASS format is used because FFmpeg renders it beautifully with custom fonts/colors.
   */
  ztteam_generateASSContent(
    subtitles: Array<{ start: number; end: number; text: string }>,
    videoY: number = 0,
    videoHeight: number = 1920,
    hookText?: string,
    subtitlesY?: number
  ): string {
    const formatTime = (seconds: number): string => {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      const cs = Math.round((seconds % 1) * 100);
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
    };

    /** Position subtitle based on subtitlesY or inside the video frame */
    const bottomOfVideo = videoY + videoHeight;
    /** For Alignment=8 (Top Center), MarginV is from the top! */
    const marginV = subtitlesY !== undefined ? subtitlesY : (bottomOfVideo + 40);
    const topMarginV = Math.max(120, videoY + 120);

    let ass = `[Script Info]
Title: ZTReel Subtitles
ScriptType: v4.00+
WrapStyle: 1
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Montserrat Black,60,&H0000FFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,0,2,8,40,40,${marginV},1
Style: Hook,Montserrat Black,70,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,0,3,8,40,40,${topMarginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

    if (hookText && subtitles.length > 0) {
      /** Show hook text for the first 5 seconds or until video ends */
      const hookEnd = formatTime(Math.min(5, subtitles[subtitles.length - 1].end));
      ass += `Dialogue: 1,0:00:00.00,${hookEnd},Hook,,0,0,0,,{\\b1\\c&H00FFFF&\\3c&H000000&}${hookText}\n`;
    }

    for (const sub of subtitles) {
      const durationSec = sub.end - sub.start;
      const words = sub.text.split(' ').filter(w => w.trim().length > 0);
      if (words.length === 0) continue;

      /** Fake karaoke effect: split duration equally among words */
      const wordDurationCs = Math.round((durationSec * 100) / words.length);
      const karaokeText = words.map(w => `{\\k${wordDurationCs}}${w}`).join(' ');

      ass += `Dialogue: 0,${formatTime(sub.start)},${formatTime(sub.end)},Default,,0,0,0,,${karaokeText}\n`;
    }

    return ass;
  }

  /** Mock script for development without API key */
  private ztteam_getMockScript(postContent: string): string {
    const firstSentence = postContent.split(/[.!?]/)[0]?.trim() || 'Tin tức nóng hổi';
    return `Bạn có biết? ${firstSentence}. Đây là thông tin bạn không nên bỏ lỡ. Theo dõi ngay để cập nhật thêm!`;
  }

  /**
   * Transcribe an audio file using OpenAI Whisper (Speech to Text)
   * @param audioPath - Path to the local MP3/WAV file
   * @returns The transcribed text
   */
  async ztteam_transcribeAudio(audioPath: string): Promise<string> {
    const settings = await this.getSettings();
    if (!settings.openaiKey) {
      throw new Error('Bạn chưa cấu hình OpenAI API Key để dùng Whisper.');
    }

    this.logger.log(`Transcribing audio: ${audioPath}`);
    const fs = require('fs');

    try {
      const OpenAI = require('openai').default;
      const openai = new OpenAI({ apiKey: settings.openaiKey.trim() });

      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(audioPath),
        model: 'whisper-1',
        language: 'vi',
        prompt: 'Đây là một video TikTok tiếng Việt. Nếu có đoạn nhạc không lời hoặc im lặng, hãy bỏ qua và không ghi gì cả.',
        temperature: 0,
      });

      let text = transcription.text.trim();

      /** Basic filter for common Whisper hallucinations on silence/music */
      const hallucinations = ['Biên lơn thắng cô hồn', 'cảm ơn các bạn', 'đăng ký kênh', 'hẹn gặp lại', 'chúc các bạn', 'Amara.org'];
      for (const h of hallucinations) {
        if (text.toLowerCase().includes(h.toLowerCase()) && text.length < 50) {
          text = '';
        }
      }

      return text;
    } catch (error: any) {
      this.logger.error(`Error transcribing audio: ${error.message}`);
      throw new Error('Lỗi chuyển đổi giọng nói thành văn bản: ' + error.message);
    }
  }

  /**
   * Rewrite an original script (e.g. from TikTok) into a new, unique script for a Reel.
   * @param originalText - The transcribed text from original video
   * @param customPrompt - Optional custom instructions
   * @returns The generated script object
   */
  async ztteam_rewriteTikTokScript(
    originalText: string,
    customPrompt?: string | null,
  ): Promise<{ caption: string; hook: string; sub_voice: string }> {
    this.logger.log(`Rewriting TikTok script`);

    const settings = await this.getSettings();
    if (!settings.openaiKey && !settings.deepseekKey && !settings.geminiKey) {
      throw new Error('Chưa cấu hình API Key (OpenAI/Gemini/Deepseek) để viết lại kịch bản.');
    }

    const defaultSystemPrompt = `Bạn là chuyên gia Reup nội dung Video ngắn (Reel/TikTok) chuyên nghiệp.
Dưới đây là nội dung bóc băng từ một video TikTok của người khác. Nhiệm vụ của bạn là VIẾT LẠI (Rephrase) kịch bản này để làm một video mới.

QUY TẮC TUYỆT ĐỐI CẦN TUÂN THỦ:
- BÁM SÁT NỘI DUNG GỐC: Bạn PHẢI giữ nguyên ý nghĩa cốt lõi của bản gốc.
- NGẮN GỌN & GIẬT GÂN: Kịch bản mới phải mang hơi hướng kịch tính, giật gân, gây sốc nhẹ hoặc tò mò tột độ. Viết thật ngắn gọn, súc tích (khoảng 80 - 120 từ).
- CHỈ THAY ĐỔI CÂU TỪ: Hãy diễn đạt lại bằng từ đồng nghĩa, tuyệt đối không trùng lặp từ ngữ với bản gốc (để lách bản quyền).
- Hook (Câu đầu tiên) phải cực kỳ giật gân và thu hút.
- BẮT BUỘC Ở CUỐI VIDEO: Bạn phải thêm chính xác câu này vào cuối kịch bản: "Liên hệ với chúng tôi qua Zalo 0919901493 hoặc gọi trực tiếp để được hỗ trợ nhanh hơn".
- KHÔNG dùng emoji, hashtag, hay kí tự đặc biệt trong kịch bản giọng đọc (sub_voice).`;

    const systemPrompt = customPrompt ? customPrompt : defaultSystemPrompt;
    const promptWithRules = `${systemPrompt}

IMPORTANT: YOU MUST ALWAYS RETURN THE RESULT IN VIETNAMESE.
YOU MUST RETURN EXACTLY ONE JSON OBJECT WITH THE FOLLOWING STRUCTURE:
{
  "caption": "A catchy social media caption (with hashtags)",
  "hook": "A short, engaging text hook to display on the video",
  "sub_voice": "The spoken script for the voiceover. BẮT BUỘC PHẢI KẾT THÚC BẰNG CÂU LIÊN HỆ ZALO 0919901493."
}`;

    const userContent = `Original Script:\n\n${originalText.substring(0, 3000)}`;

    try {
      if (settings.activeProvider === 'gemini' && settings.geminiKey) {
        const text = await this.ztteam_callGeminiWithFallback(
          settings.geminiKey,
          `${promptWithRules}\n\n${userContent}`,
          { jsonMode: true, temperature: 0.8, maxTokens: 500 }
        );
        const jsonResult = JSON.parse(text || '{}');
        return {
          caption: jsonResult.caption || '',
          hook: jsonResult.hook || '',
          sub_voice: jsonResult.sub_voice || ''
        };
      } else {
        const OpenAI = require('openai').default;
        const isDeepseek = settings.activeProvider === 'deepseek' && settings.deepseekKey;
        const rawKey = isDeepseek ? settings.deepseekKey : settings.openaiKey;
        const apiKey = (rawKey || '').trim();
        const baseURL = isDeepseek ? 'https://api.deepseek.com' : undefined;
        const modelName = isDeepseek ? 'deepseek-chat' : 'gpt-4o-mini';

        const openai = new OpenAI({ apiKey, baseURL });
        const response = await openai.chat.completions.create({
          model: modelName,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: promptWithRules },
            { role: 'user', content: userContent },
          ],
          max_tokens: 500,
          temperature: 0.8,
        });

        const resultString = response.choices[0]?.message?.content?.trim() || '{}';
        const result = JSON.parse(resultString);

        return {
          caption: result.caption || '',
          hook: result.hook || '',
          sub_voice: result.sub_voice || ''
        };
      }
    } catch (error: any) {
      this.logger.error(`AI rewrite failed: ${error.message}`);
      throw new Error('Lỗi khi AI viết lại kịch bản: ' + error.message);
    }
  }

  /**
   * ZTTeam: Viết lại kịch bản câu chuyện cho Muse.ai khi bị từ chối
   * Dựa chính xác vào thông báo từ chối của Muse để khắc phục vi phạm,
   * bám sát nội dung gốc nhất có thể, nhưng chuyển sang phong cách điện ảnh an toàn 100%.
   */
  async ztteam_rewriteSafeStoryForMuse(originalContent: string, museFeedback: string): Promise<string> {
    const settings = await this.getSettings();
    if (!settings.openaiKey && !settings.geminiKey) {
      throw new Error('Chưa cấu hình API Key AI (OpenAI hoặc Gemini).');
    }

    const systemPrompt = `You are an elite Hollywood script doctor and video prompt specialist for Muse.ai.
A video generation request on Muse.ai was STRICTLY REJECTED with this message from Muse's safety filter:
"${museFeedback}"

Your mission is to rewrite the story into an engaging, dramatic 15-second cinematic teaser (3-4 sentences in English) that is 100% COMPLIANT with Muse's policy.

CRITICAL RULES:
1. ADAPT MUSE'S SUGGESTION:
   - Carefully read Muse's feedback: "${museFeedback}". If Muse suggested a safe alternative direction (e.g. starting a new life, emotional departure, uncovering a secret without mentioning divorce or papers), YOU MUST FULLY EMBRACE AND FOLLOW THAT DIRECTION.
2. ABSOLUTELY FORBIDDEN WORDS (DO NOT USE ANY OF THESE WORDS OR VARIATIONS):
   - NO: "backup", "backup husband", "backup spouse", "divorce", "divorced", "divorcing", "affair", "cheating", "ex", "ex-husband", "ex-wife", "mistress", "wife", "husband"
   - NO: "signed a document", "sign a document", "agreement", "papers", "contract", "lawsuit", "sue", "court", "defamation"
   - NO: "blood", "kill", "murder", "gun", "weapon", "crime", "dead", "corpse", "violence"
3. HOW TO CONVERT THE CONFLICT SAFELY:
   - Keep the main character's name (e.g. Matthew), the dramatic tension, the departure/flight to Australia, the clever plan, and the unexpected twist.
   - Frame the conflict as a dramatic personal parting of ways, a betrayal of trust, or a new beginning after heartbreak — NEVER mention marriage dissolution, backup husbands, or signing papers.
4. FORMAT: Output ONLY the 3-4 sentence English story ready for video generation narration. No quotes, no intro, no explanation.`;

    try {
      if (settings.activeProvider === 'gemini' && settings.geminiKey) {
        const text = await this.ztteam_callGeminiWithFallback(
          settings.geminiKey,
          `${systemPrompt}\n\nORIGINAL STORY:\n"""\n${originalContent}\n"""`,
          { temperature: 0.7, maxTokens: 350 }
        );
        return (text || '').trim();
      } else {
        const OpenAI = require('openai').default;
        const apiKey = (settings.openaiKey || '').trim();
        const openai = new OpenAI({ apiKey });

        const response = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `ORIGINAL STORY:\n"""\n${originalContent}\n"""` },
          ],
          max_tokens: 350,
          temperature: 0.7,
        });

        return response.choices[0]?.message?.content?.trim() || originalContent;
      }
    } catch (e: any) {
      this.logger.error(`Error rewriting safe story for Muse: ${e.message}`);
      throw new Error(`Lỗi khi AI viết lại kịch bản an toàn: ${e.message}`);
    }
  }

  /**
   * ZTTeam: Tạo kịch bản Hook 3 đoạn cho Video Reel từ bài viết gốc
   * Bám sát 100% cốt truyện thực tế của bài viết, cực kỳ kịch tính, lôi cuốn
   * Tự động highlight từ khóa cảm xúc bằng thẻ <span class="hl">...</span>
   */
  /**
   * ZTTeam: Tạo nội dung bài đăng Facebook & Video Reel theo chuẩn True-Crime Cold Case
   * Gồm: 1. TOP LABEL, 2. HOOK HEADLINE, 3. YELLOW BANNER, 4. BODY (8-12 câu, [[...]] cho key lines),
   * 5. ENDING cliffhanger, 6. COMMENT TEXT (120-180 từ tiết lộ kết quả + link), 7. 5 Hashtags
   */
  async ztteam_generateColdCaseContent(
    title: string,
    content: string,
    customPrompt?: string | null,
    postUrl?: string,
  ): Promise<ZTTeamColdCaseResult> {
    const cleanTitle = (title || '').replace(/<[^>]*>?/gm, '').trim();
    const cleanContent = (content || '').replace(/<[^>]*>?/gm, '').replace(/\s+/g, ' ').trim();

    const defaultSystemPrompt = `You are a true-crime storyteller who writes short, gripping cold-case posts for Facebook and Reels. Your style is serious, factual, and suspenseful.

CASE INFO
- Case Title: "${cleanTitle}"
- Verified facts (use ONLY these):
"""
${cleanContent.substring(0, 4500)}
"""

OUTPUT STRUCTURE

1. TOP LABEL (max 4 words): location/case type + year.
   Examples: "UNSOLVED – 1982", "TEXAS 1986"

2. HOOK HEADLINE (max 15 words): one paradox or time gap that raises a question the reader must answer.
   Formulas: "[X] years later, [unexpected thing] revealed everything" /
   "He confessed to [someone], but it was never reported"

3. YELLOW BANNER (1 line): "[PLACE] [YEAR] Cold Case [Solved/Identified] After [X] Years — Justice for [Victim's full name]"

4. BODY (8–12 short sentences):
   - Chronological order. Optionally open with one flash-forward sentence
     ("Thirty-eight years later, a dying man asked to speak to a priest…"),
     then go back to the beginning.
   - Start with an ordinary situation (a routine day, a normal errand).
   - Include 3 strange, concrete, visual details taken from the facts
     (objects, positions, clothing, small anomalies).
   - Add 1 "suspicion seed": a tiny detail with no explanation
     (e.g. "His wife never looked at him during the interview.")
   - Add 1 "weight" sentence: a historical fact that raises the stakes
     (e.g. "It was the first recorded case of its kind in the state.")
   - Sentences are 8–15 words. Plain words, 6th–8th grade level.
   - Neutral reporting tone. Few emotional adjectives. Let the details speak.
   - Mark every 2nd–3rd sentence as a KEY LINE by wrapping it in [[double brackets]]
     so I can highlight it yellow (e.g. [[Her car was found three days later, parked neatly with the engine running.]]).
     Key lines must be the most dramatic ones, and they should tell the story on their own if read alone.

5. ENDING: stop right before the answer is revealed with an open-ended cliffhanger
   ("…but learning that would take forty years." / "…and finally revealed what he had kept hidden…").
   Final line: "See more in the comments section below 👇"

6. COMMENT TEXT (for the first comment): 120–180 words continuing the story
   and revealing the resolution, with the same tone. End with a respectful
   line honoring the victim.

7. HASHTAGS: Exactly 5 relevant hashtags (e.g. #ColdCase #TrueCrime #JusticeServed #Unsolved #DNAEvidence).

STRICT RULES
- Do NOT invent details, dialogue, suspects, motives, or emotions. If a fact is missing, leave it out.
- No graphic descriptions of violence or injuries. Imply, don't describe.
- Treat the victim with dignity. Never blame or sensationalize.
- Never name an unconvicted person as guilty. Use "suspect," "person of interest," or "told detectives."
- If the facts are insufficient for a section, tell me what's missing instead of guessing.

YOU MUST RETURN STRICTLY A SINGLE VALID JSON OBJECT WITH THIS EXACT STRUCTURE (NO EXTRA TEXT):
{
  "topLabel": "LOCATION YEAR",
  "hookHeadline": "Headline paradox text here",
  "yellowBanner": "Yellow banner single line here",
  "body": "Sentence 1. [[Key line sentence 2.]] Sentence 3...",
  "ending": "Cliffhanger sentence.\\n\\nSee more in the comments section below 👇",
  "commentText": "Resolution comment text (120-180 words)...",
  "hashtags": ["#ColdCase", "#TrueCrime", "#JusticeServed", "#Unsolved", "#DNAEvidence"]
}`;

    const promptToUse = customPrompt
      ? `${customPrompt}\n\nCASE TITLE: ${cleanTitle}\nFACTS:\n${cleanContent.substring(0, 4500)}\n\nIMPORTANT: Return valid JSON matching the specified fields.`
      : defaultSystemPrompt;

    try {
      const settings = await this.getSettings();
      let rawResponse = '';

      if (settings.activeProvider === 'gemini' && settings.geminiKey) {
        rawResponse = await this.ztteam_callGeminiWithFallback(
          settings.geminiKey,
          promptToUse,
          { jsonMode: true, temperature: 0.7, maxTokens: 2000 }
        );
      } else {
        const OpenAI = require('openai').default;
        const isDeepseek = settings.activeProvider === 'deepseek' && settings.deepseekKey;
        const rawKey = isDeepseek ? settings.deepseekKey : settings.openaiKey;
        const apiKey = (rawKey || '').trim();
        const baseURL = isDeepseek ? 'https://api.deepseek.com' : undefined;
        const modelName = isDeepseek ? 'deepseek-chat' : 'gpt-4o-mini';

        if (apiKey) {
          const openai = new OpenAI({ apiKey, baseURL });
          const response = await openai.chat.completions.create({
            model: modelName,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'user', content: promptToUse },
            ],
            max_tokens: 2000,
            temperature: 0.7,
          });
          rawResponse = response.choices[0]?.message?.content || '{}';
        }
      }

      const jsonResult = this.ztteam_safeParseJson(rawResponse);
      if (jsonResult && (jsonResult.body || jsonResult.hookHeadline || jsonResult.commentText)) {
        return this.ztteam_formatColdCaseResult(jsonResult, cleanTitle, cleanContent, postUrl);
      }
    } catch (err: any) {
      this.logger.error(`Cold case AI generation error: ${err.message}`);
    }

    return this.ztteam_fallbackColdCaseExtract(cleanTitle, cleanContent, postUrl);
  }

  /**
   * ZTTeam: Format and normalize cold case result
   */
  private ztteam_formatColdCaseResult(
    jsonResult: any,
    title: string,
    content: string,
    postUrl?: string,
  ): ZTTeamColdCaseResult {
    const topLabel = (jsonResult.topLabel || 'COLD CASE').trim();
    const hookHeadline = (jsonResult.hookHeadline || title).trim();
    const yellowBanner = (jsonResult.yellowBanner || `Cold Case Investigation — ${title}`).trim();
    let body = (jsonResult.body || '').trim();
    let ending = (jsonResult.ending || 'See more in the comments section below 👇').trim();
    if (!ending.toLowerCase().includes('comments section below')) {
      ending += '\n\nSee more in the comments section below 👇';
    }

    let commentText = (jsonResult.commentText || '').trim();
    if (postUrl && !commentText.includes(postUrl)) {
      commentText += `\n\n👉 Full Case Details: ${postUrl}`;
    }

    const defaultTags = ['#ColdCase', '#TrueCrime', '#JusticeServed', '#Unsolved', '#Investigation'];
    const hashtags = Array.isArray(jsonResult.hashtags) && jsonResult.hashtags.length > 0
      ? jsonResult.hashtags.map((t: string) => t.startsWith('#') ? t : `#${t}`).slice(0, 5)
      : defaultTags;

    const videoBodyHtml = body.replace(/\[\[(.*?)\]\]/gs, '<span class="hl">$1</span>');

    let paragraphs = body
      .split(/\n\s*\n/)
      .map((p: string) => p.replace(/\[\[(.*?)\]\]/gs, '<span class="hl">$1</span>').trim())
      .filter((p: string) => p.length > 0);

    if (paragraphs.length < 2) {
      const sentences = body.split(/(?<=[.!?])\s+/).filter((s: string) => s.trim().length > 0);
      if (sentences.length >= 4) {
        const chunkSize = Math.ceil(sentences.length / 3);
        paragraphs = [
          sentences.slice(0, chunkSize).join(' '),
          sentences.slice(chunkSize, chunkSize * 2).join(' '),
          sentences.slice(chunkSize * 2).join(' ')
        ].map((p: string) => p.replace(/\[\[(.*?)\]\]/gs, '<span class="hl">$1</span>').trim()).filter(Boolean);
      }
    }

    const fullCaption = [
      topLabel,
      hookHeadline,
      yellowBanner,
      body,
      ending,
      hashtags.join(' ')
    ].filter(Boolean).join('\n\n');

    return {
      topLabel,
      hookHeadline,
      yellowBanner,
      body,
      ending,
      commentText,
      hashtags,
      fullCaption,
      videoBodyHtml,
      paragraphs,
    };
  }

  /**
   * ZTTeam: Fallback extractor if AI API key is missing or fails
   */
  private ztteam_fallbackColdCaseExtract(
    title: string,
    content: string,
    postUrl?: string,
  ): ZTTeamColdCaseResult {
    const cleanTitle = (title || 'Mysterious Disappearance').trim();
    const cleanContent = (content || '').trim();

    const topLabel = 'COLD CASE';
    const hookHeadline = cleanTitle;
    const yellowBanner = `Cold Case Investigation — ${cleanTitle}`;

    const sentences = cleanContent.split(/(?<=[.!?])\s+/).filter((s: string) => s.length > 20);
    const bodySentences = sentences.slice(0, 8);

    const bodyFormatted = bodySentences.map((s: string, idx: number) => {
      if ((idx + 1) % 3 === 0) {
        return `[[${s.trim()}]]`;
      }
      return s.trim();
    }).join(' ');

    const ending = 'The truth remained hidden for decades, waiting for modern technology to bring justice.\n\nSee more in the comments section below 👇';

    let commentText = sentences.slice(8, 14).join(' ');
    if (!commentText || commentText.length < 50) {
      commentText = `Investigators continued reviewing historical evidence, interviewing acquaintances, and testing recovered forensic materials. Today, modern forensic science continues to bring long-overdue answers to families who never gave up hope.`;
    }
    if (postUrl) {
      commentText += `\n\n👉 Full Case Details: ${postUrl}`;
    }

    const hashtags = ['#ColdCase', '#TrueCrime', '#JusticeServed', '#Unsolved', '#Investigation'];
    const body = bodyFormatted || cleanContent.substring(0, 600);
    const videoBodyHtml = body.replace(/\[\[(.*?)\]\]/gs, '<span class="hl">$1</span>');
    const paragraphs = [body.substring(0, 200), body.substring(200, 400), body.substring(400, 600)].map((p: string) => p.replace(/\[\[(.*?)\]\]/gs, '<span class="hl">$1</span>').trim()).filter(Boolean);

    const fullCaption = [
      topLabel,
      hookHeadline,
      yellowBanner,
      body,
      ending,
      hashtags.join(' ')
    ].filter(Boolean).join('\n\n');

    return {
      topLabel,
      hookHeadline,
      yellowBanner,
      body,
      ending,
      commentText,
      hashtags,
      fullCaption,
      videoBodyHtml,
      paragraphs,
    };
  }

  /**
   * ZTTeam: Trích xuất các đoạn văn từ nội dung Cold Case đã có định dạng [[...]]
   */
  private ztteam_extractParagraphsFromColdCase(content: string): string[] {
    const clean = (content || '').trim();
    const lines = clean.split(/\n\s*\n/).filter(l => {
      const trimmed = l.trim();
      return trimmed.length > 30 && !trimmed.startsWith('#') && !trimmed.includes('See more in the comments');
    });

    const paragraphs: string[] = [];
    for (const line of lines) {
      if (line.includes('[[') || line.length > 50) {
        paragraphs.push(line.replace(/\[\[(.*?)\]\]/gs, '<span class="hl">$1</span>').trim());
      }
    }
    return paragraphs.length > 0 ? paragraphs : [clean.substring(0, 300)];
  }

  async ztteam_generateReelHookStory(
    title: string,
    content: string,
  ): Promise<{ hookHtml: string; plainText: string; paragraphs: string[] }> {
    const cleanTitle = (title || '').replace(/<[^>]*>?/gm, '').trim();
    const cleanContent = (content || '').replace(/<[^>]*>?/gm, '').replace(/\s+/g, ' ').trim();

    // 1. Nếu nội dung đầu vào đã có sẵn định dạng Cold Case với [[...]], trích xuất trực tiếp
    if (cleanContent.includes('[[') && cleanContent.includes(']]')) {
      const extracted = this.ztteam_extractParagraphsFromColdCase(cleanContent);
      if (extracted && extracted.length >= 1) {
        const finalParagraphs = extracted.slice(0, 3);
        const hookHtml = finalParagraphs.map(p => `<p>${p}</p>`).join('\n');
        const plainText = finalParagraphs.join('\n\n').replace(/<[^>]*>?/gm, '');
        return { hookHtml, plainText, paragraphs: finalParagraphs };
      }
    }

    const systemPrompt = `You are a master viral Facebook Reel copywriter.
Based strictly on the provided real story:
Title: "${cleanTitle}"
Story Details:
"${cleanContent.substring(0, 3000)}"

Task:
Write a viral, high-suspense 3-paragraph Hook in ENGLISH for a 10-second Facebook Reel.

CRITICAL REQUIREMENTS:
1. TRUTHFUL TO ORIGINAL STORY: Every fact must be based strictly on the provided story details. Do NOT make up fake, irrelevant names or events.
2. EXACTLY 3 DISTINCT PARAGRAPHS:
   - Paragraph 1: An electrifying, curiosity-inducing opening hook based on the core event.
   - Paragraph 2: The climax, shocking twist, or intense confrontation from the story.
   - Paragraph 3: A compelling cliffhanger question or tease that makes the viewer desperate to read the full story in the comments.
3. KEYWORD HIGHLIGHTS: In each paragraph, wrap 1 to 2 key phrases in <span class="hl">...</span> (e.g. <span class="hl">DNA test</span>, <span class="hl">secret room</span>).
4. TOTAL LENGTH: Keep between 65 to 85 words total across all 3 paragraphs. (Do NOT exceed 95 words so text fits elegantly on screen).
5. FORMAT OUTPUT: Return strictly 3 paragraphs separated by double line breaks. No titles, no numbering (like 1., 2.), no quotes, no markdown headers.`;

    try {
      const settings = await this.getSettings();
      let rawResponse = '';

      if (settings.activeProvider === 'gemini' && settings.geminiKey) {
        rawResponse = await this.ztteam_callGeminiWithFallback(
          settings.geminiKey,
          systemPrompt,
          { temperature: 0.75, maxTokens: 300 }
        );
      } else {
        const OpenAI = require('openai').default;
        const isDeepseek = settings.activeProvider === 'deepseek' && settings.deepseekKey;
        const rawKey = isDeepseek ? settings.deepseekKey : settings.openaiKey;
        const apiKey = (rawKey || '').trim();
        const baseURL = isDeepseek ? 'https://api.deepseek.com' : undefined;
        const modelName = isDeepseek ? 'deepseek-chat' : 'gpt-4o-mini';

        if (apiKey) {
          const openai = new OpenAI({ apiKey, baseURL });
          const response = await openai.chat.completions.create({
            model: modelName,
            messages: [
              { role: 'user', content: systemPrompt },
            ],
            max_tokens: 300,
            temperature: 0.75,
          });
          rawResponse = response.choices[0]?.message?.content || '';
        }
      }

      if (rawResponse && rawResponse.trim().length > 30) {
        /** Tách đoạn văn ưu tiên theo ngắt dòng kép, sau đó đến ngắt dòng đơn */
        let paragraphs = rawResponse
          .trim()
          .split(/\n\s*\n/)
          .map(p => p.trim())
          .filter(p => p.length > 0);

        /** Nếu không có ngắt dòng kép, thử tách theo ngắt dòng đơn */
        if (paragraphs.length < 2) {
          const singleLineSplits = rawResponse
            .trim()
            .split(/\n+/)
            .map(p => p.trim())
            .filter(p => p.length > 15);
          if (singleLineSplits.length >= 2) {
            paragraphs = singleLineSplits;
          }
        }

        /** Nếu vẫn chỉ có 1 đoạn văn nhưng nội dung dày dặn (> 80 ký tự), tự động chia theo câu hoặc giữ nguyên 1 đoạn hoàn chỉnh */
        if (paragraphs.length === 1 && paragraphs[0].length >= 30) {
          const sentences = paragraphs[0].match(/[^.!?]+[.!?]+(\s|$)/g);
          if (sentences && sentences.length >= 2) {
            const mid = Math.ceil(sentences.length / 2);
            paragraphs = [
              sentences.slice(0, mid).join('').trim(),
              sentences.slice(mid).join('').trim()
            ].filter(p => p.length > 0);
          }
        }

        if (paragraphs.length >= 1) {
          const finalParagraphs = paragraphs.slice(0, 3);
          const hookHtml = finalParagraphs.map(p => `<p>${p}</p>`).join('\n');
          const plainText = finalParagraphs.join('\n\n').replace(/<[^>]*>?/gm, '');
          return { hookHtml, plainText, paragraphs: finalParagraphs };
        }
      }

      throw new Error(`AI không thể tạo kịch bản hook đạt chuẩn chất lượng (Kết quả trả về rỗng hoặc quá ngắn dưới 30 ký tự).`);
    } catch (err: any) {
      this.logger.error(`AI hook generation failed: ${err.message}`);
      throw new Error(`Lỗi AI tạo Hook kịch tính: ${err.message}`);
    }
  }

  /**
   * ZTTeam: Định dạng nội dung câu chuyện cho Text Story Reel (9:16 Frosted Glass)
   * - Bao gồm 1 câu Hook mở đầu kịch tính trong ngoặc kép (Quote)
   * - Tiếp theo là 5-6 đoạn văn dày dặn (~250 - 280 từ) bám sát 100% cốt truyện gốc
   * - Tự động bọc từ khóa cao trào bằng <span class="hl">...</span>
   * - Lấp kín card 1575px, để trống đúng ~10% ở đáy màn hình
   */
  async ztteam_generateTextStoryCardContent(
    title: string,
    content: string,
  ): Promise<{ hookQuote: string; paragraphs: string[]; plainText: string }> {
    const cleanTitle = (title || '').replace(/<[^>]*>?/gm, '').trim();
    const cleanContent = (content || '').replace(/<[^>]*>?/gm, '').replace(/\s+/g, ' ').trim();

    // 1. Nếu nội dung đầu vào đã có sẵn định dạng Cold Case với [[...]], trích xuất trực tiếp
    if (cleanContent.includes('[[') && cleanContent.includes(']]')) {
      const chunks = cleanContent.split(/\n\s*\n/).filter(l => Boolean(l.trim()));
      const hookQuote = chunks.find(l => l.length < 120 && !l.includes('[[') && !l.startsWith('#')) || cleanTitle;
      const bodyLines = chunks.filter(l => l.includes('[[') || (l.length > 50 && !l.startsWith('#') && !l.includes('See more in the comments')));
      if (bodyLines.length >= 2) {
        const paragraphs = bodyLines.map(p => p.replace(/\[\[(.*?)\]\]/gs, '<span class="hl">$1</span>').trim());
        const plainText = paragraphs.join('\n\n').replace(/<[^>]*>?/gm, '');
        return {
          hookQuote: `“${hookQuote.replace(/^["'“”]+|["'“”]+$/g, '')}”`,
          paragraphs,
          plainText,
        };
      }
    }

    const systemPrompt = `You are a master viral Facebook Story copywriter specializing in high-suspense Text Story Reels.
Based strictly on the provided real story:
Title: "${cleanTitle}"
Story Details:
"${cleanContent.substring(0, 4500)}"

Task:
Format and condense this real story into a dense, electrifying viral Text Story for a 9:16 vertical card.

CRITICAL REQUIREMENTS:
1. TRUTHFUL TO ORIGINAL: Every character, quote, and detail must come strictly from the provided story.
2. FIRST LINE: A dramatic, quote-based opening hook line (1 short sentence in quotation marks, e.g. "Get in the back, Lena. Paige needs your seat.")
3. STORY BODY: Exactly 5 or 6 paragraphs.
4. TOTAL LENGTH: Total word count across the body MUST be between 250 and 280 words so it fills the screen card completely without leaving empty space.
5. HIGHLIGHTS: In each paragraph, wrap 1 or 2 dramatic phrases or key quotes in <span class="hl">...</span>.
6. SUSPENSE CLIFFHANGER: End on an intense high-stakes moment or revelation that compels the viewer to read the rest in the comments.
7. FORMAT: Return the opening hook quote on line 1, followed by a blank line, followed by the 5-6 paragraphs separated by blank lines. No numbering, no markdown headers.`;

    try {
      const settings = await this.getSettings();
      let rawResponse = '';

      if (settings.activeProvider === 'gemini' && settings.geminiKey) {
        rawResponse = await this.ztteam_callGeminiWithFallback(
          settings.geminiKey,
          systemPrompt,
          { temperature: 0.75, maxTokens: 600 }
        );
      } else {
        const OpenAI = require('openai').default;
        const isDeepseek = settings.activeProvider === 'deepseek' && settings.deepseekKey;
        const rawKey = isDeepseek ? settings.deepseekKey : settings.openaiKey;
        const apiKey = (rawKey || '').trim();
        const baseURL = isDeepseek ? 'https://api.deepseek.com' : undefined;
        const modelName = isDeepseek ? 'deepseek-chat' : 'gpt-4o-mini';

        if (apiKey) {
          const openai = new OpenAI({ apiKey, baseURL });
          const response = await openai.chat.completions.create({
            model: modelName,
            messages: [
              { role: 'user', content: systemPrompt },
            ],
            max_tokens: 600,
            temperature: 0.75,
          });
          rawResponse = response.choices[0]?.message?.content || '';
        }
      }

      if (rawResponse && rawResponse.trim().length > 100) {
        const chunks = rawResponse
          .trim()
          .split(/\n\s*\n/)
          .map(p => p.trim())
          .filter(p => p.length > 0);

        if (chunks.length >= 4) {
          const hookQuote = chunks[0].replace(/^["'“”]+|["'“”]+$/g, '').trim();
          const paragraphs = chunks.slice(1);
          const plainText = paragraphs.join('\n\n').replace(/<[^>]*>?/gm, '');
          return {
            hookQuote: `“${hookQuote}”`,
            paragraphs,
            plainText,
          };
        }
      }
    } catch (err: any) {
      this.logger.warn(`AI text story generation warning: ${err.message}. Chuyển sang trích xuất trực tiếp.`);
    }

    /** ZTTeam: Fallback thông minh nếu AI lỗi hoặc không có API key - tự động trích xuất 260 từ từ nội dung gốc */
    return this.ztteam_fallbackTextStoryExtract(cleanTitle, cleanContent);
  }

  /**
   * ZTTeam: Thuật toán fallback trích xuất 250 - 280 từ trực tiếp từ bài viết gốc
   */
  private ztteam_fallbackTextStoryExtract(
    title: string,
    content: string,
  ): { hookQuote: string; paragraphs: string[]; plainText: string } {
    const hookQuote = title.length > 5 ? `“${title}”` : '“A Story You Need To Hear...”';
    const rawWords = content.split(/\s+/).filter(w => w.length > 0);
    const targetWords = rawWords.slice(0, 270);

    /** Chia 270 từ thành 5-6 đoạn */
    const paragraphCount = 5;
    const chunkSize = Math.ceil(targetWords.length / paragraphCount);
    const paragraphs: string[] = [];

    for (let i = 0; i < targetWords.length; i += chunkSize) {
      let pText = targetWords.slice(i, i + chunkSize).join(' ');
      /** Tự động bôi vàng từ khóa bằng regex trên một số từ/cụm từ cảm xúc */
      pText = pText.replace(/\b(husband|wife|marriage|hospital|police|secret|truth|money|million|house|car|lawyer|divorce|pain|tears|betrayal|revenge|company)\b/gi, (m) => `<span class="hl">${m}</span>`);
      paragraphs.push(pText);
    }

    const plainText = paragraphs.join('\n\n').replace(/<[^>]*>?/gm, '');
    return { hookQuote, paragraphs, plainText };
  }

  /**
   * ZTTeam: Sáng tạo prompt chuẩn cho Avatar (1:1) và Cover (16:9) bám sát chủ đề Story và chèn tên Page vào cả 2 ảnh
   */
  async ztteam_generateBrandingPrompts(params: {
    pageName: string;
    category?: string | null;
    siteUrl?: string | null;
    tags?: string[];
    recentTitles?: string[];
  }): Promise<{ avatarPrompt: string; coverPrompt: string }> {
    const { pageName } = params;

    /**
     * ZTTeam: Cấu trúc câu lệnh chuẩn bám sát yêu cầu:
     * - Page làm chuyên đề Story
     * - Lấy tên Fanpage "${pageName}"
     * - Chèn tên Page vào cả 2 ảnh theo phong cách typography nghệ thuật / tiêu đề thương hiệu
     */
    const avatarPrompt = `This Facebook page is dedicated to story content. Based on the page name "${pageName}", create a compelling 1:1 square avatar profile picture that represents the storytelling theme. Clearly and beautifully integrate the exact brand name text "${pageName}" in stylish, modern typography into the artwork, dramatic cinematic lighting, rich emotional atmosphere, 8k resolution, photorealistic.`;

    const coverPrompt = `This Facebook page is dedicated to story content. Based on the page name "${pageName}", create a breathtaking cinematic 16:9 cover banner that captures the mood and atmosphere of this storytelling page. Prominently display the exact page title text "${pageName}" in bold, elegant cinematic typography across the banner, immersive atmospheric depth, rich storytelling lighting, 8k resolution.`;

    return {
      avatarPrompt,
      coverPrompt,
    };
  }

  /**
   * ZTTeam: Vẽ ảnh chất lượng cao bằng OpenAI DALL-E 3 (Hỗ trợ tỉ lệ vuông 1:1 và ngang 16:9)
   */
  async ztteam_renderImageWithDallE(prompt: string, aspectRatio: '1:1' | '16:9' = '1:1'): Promise<{
    imageUrl: string;
    localPath: string;
  }> {
    const settings = await this.getSettings();
    const apiKey = (settings.openaiKey || process.env.OPENAI_API_KEY || '').trim();
    if (!apiKey) {
      throw new Error('Chưa cấu hình OPENAI_API_KEY trong hệ thống');
    }

    const OpenAI = require('openai').default;
    const openai = new OpenAI({ apiKey });

    /** Tự động chọn model hình ảnh phù hợp với tài khoản */
    let selectedModel = 'gpt-image-1';
    try {
      const list = await openai.models.list();
      const modelIds: string[] = list.data.map((m: any) => m.id);
      const candidates = ['gpt-image-1', 'gpt-image-1-mini', 'gpt-image-2', 'dall-e-3', 'dall-e-2'];
      const found = candidates.find(c => modelIds.includes(c));
      if (found) {
        selectedModel = found;
      }
    } catch (e: any) {
      this.logger.warn(`Không thể lấy danh sách models OpenAI, dùng mặc định: ${selectedModel}`);
    }

    /** Size mapping: DALL-E dùng 1024x1024 / 1792x1024, GPT-Image dùng 1024x1024 / 1536x1024 */
    let size = '1024x1024';
    if (aspectRatio === '16:9') {
      size = selectedModel.startsWith('dall-e') ? '1792x1024' : '1536x1024';
    }

    this.logger.log(`Calling OpenAI Image API (model: ${selectedModel}, size: ${size}) with prompt: ${prompt.substring(0, 80)}...`);

    const response = await openai.images.generate({
      model: selectedModel,
      prompt: prompt,
      n: 1,
      size: size,
    });

    const item = response.data?.[0];
    if (!item) {
      throw new Error('OpenAI không trả về kết quả hình ảnh');
    }

    /** Tải ảnh về lưu trữ cục bộ trong storage/branding */
    const fs = require('fs');
    const path = require('path');
    const { ztteam_getStorageRoot } = require('../common/ztteam_storage.util');
    const brandingDir = path.join(ztteam_getStorageRoot(), 'branding');
    fs.mkdirSync(brandingDir, { recursive: true });

    const filename = `dalle_${Date.now()}_${Math.random().toString(36).substring(7)}.png`;
    const localPath = path.join(brandingDir, filename);

    if (item.b64_json) {
      const buffer = Buffer.from(item.b64_json, 'base64');
      fs.writeFileSync(localPath, buffer);
    } else if (item.url) {
      const imgRes = await fetch(item.url);
      if (!imgRes.ok) {
        throw new Error(`Không thể tải ảnh từ OpenAI DALL-E 3: ${imgRes.statusText}`);
      }
      const arrayBuffer = await imgRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      fs.writeFileSync(localPath, buffer);
    } else {
      throw new Error('OpenAI không trả về url hoặc b64_json');
    }

    const publicUrl = `/storage/branding/${filename}`;
    return {
      imageUrl: publicUrl,
      localPath,
    };
  }
}
