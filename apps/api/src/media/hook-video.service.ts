import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ZTTeamAIService } from '../ai/ai.service';
import { ZTTeamBgmService } from './bgm.service';
import { TelegramService, ztteam_extractErrorMessage } from '../telegram/telegram.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ztteam_getVideosPath, ztteam_getImagesPath, ztteam_getSourceOriginalsPath } from '../common/ztteam_storage.util';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import puppeteer from 'puppeteer';
import axios from 'axios';

/**
 * Danh sách 24 bộ màu Dark Seamless sang trọng, cao cấp cho Video Reel
 * Tuyệt đối không dùng màu Hồng và Tím theo quy chuẩn ZTTeam & AGENTS.md
 */
export const ZTTEAM_REEL_PALETTES = [
  {
    name: 'Dark Teal / Cyan (Mặc định)',
    background: 'linear-gradient(180deg, #022a31 0%, #011d22 50%, #011114 100%)',
    highlightColor: '#f3c35b',
    accentBorder: '#f3c35b',
    avatarGrad: 'linear-gradient(135deg, #0a7075, #005f73)',
  },
  {
    name: 'Midnight Navy (Xanh Biển Sâu)',
    background: 'linear-gradient(180deg, #061e38 0%, #031224 50%, #020b17 100%)',
    highlightColor: '#f3c35b',
    accentBorder: '#f3c35b',
    avatarGrad: 'linear-gradient(135deg, #1d4ed8, #0369a1)',
  },
  {
    name: 'Dark Emerald (Xanh Ngọc Bích)',
    background: 'linear-gradient(180deg, #062b1e 0%, #031c13 50%, #010f0a 100%)',
    highlightColor: '#f3c35b',
    accentBorder: '#f3c35b',
    avatarGrad: 'linear-gradient(135deg, #059669, #065f46)',
  },
  {
    name: 'Obsidian Slate (Đen Xám Khói)',
    background: 'linear-gradient(180deg, #1c2128 0%, #13171d 50%, #0a0d12 100%)',
    highlightColor: '#f6c445',
    accentBorder: '#f6c445',
    avatarGrad: 'linear-gradient(135deg, #374151, #1f2937)',
  },
  {
    name: 'Smoked Espresso (Nâu Cà Phê Gỗ Mun)',
    background: 'linear-gradient(180deg, #2b1d0c 0%, #1a1107 50%, #0e0904 100%)',
    highlightColor: '#f3c35b',
    accentBorder: '#f3c35b',
    avatarGrad: 'linear-gradient(135deg, #78350f, #451a03)',
  },
  {
    name: 'Gunmetal Blue (Xám Xanh Nòng Súng)',
    background: 'linear-gradient(180deg, #112233 0%, #0b1622 50%, #060c14 100%)',
    highlightColor: '#f3c35b',
    accentBorder: '#f3c35b',
    avatarGrad: 'linear-gradient(135deg, #0284c7, #075985)',
  },
  {
    name: 'Forest Pine (Xanh Rừng Thông)',
    background: 'linear-gradient(180deg, #08281a 0%, #051a11 50%, #03130c 100%)',
    highlightColor: '#34d399',
    accentBorder: '#10b981',
    avatarGrad: 'linear-gradient(135deg, #15803d, #064e3b)',
  },
  {
    name: 'Royal Sapphire (Xanh Lam Hoàng Gia)',
    background: 'linear-gradient(180deg, #0c2340 0%, #07172b 50%, #040f1c 100%)',
    highlightColor: '#60a5fa',
    accentBorder: '#3b82f6',
    avatarGrad: 'linear-gradient(135deg, #2563eb, #1e3a8a)',
  },
  {
    name: 'Charcoal Black (Đen Than Hoạt Tính)',
    background: 'linear-gradient(180deg, #18181b 0%, #101013 50%, #09090b 100%)',
    highlightColor: '#fbbf24',
    accentBorder: '#eab308',
    avatarGrad: 'linear-gradient(135deg, #52525b, #27272a)',
  },
  {
    name: 'Rustic Walnut (Nâu Gỗ Óc Chó)',
    background: 'linear-gradient(180deg, #331c0e 0%, #201108 50%, #140a05 100%)',
    highlightColor: '#f59e0b',
    accentBorder: '#d97706',
    avatarGrad: 'linear-gradient(135deg, #92400e, #451a03)',
  },
  {
    name: 'Deep Abyss (Xanh Thẳm Đại Dương)',
    background: 'linear-gradient(180deg, #071a2c 0%, #04101c 50%, #020912 100%)',
    highlightColor: '#38bdf8',
    accentBorder: '#0284c7',
    avatarGrad: 'linear-gradient(135deg, #0369a1, #082f49)',
  },
  {
    name: 'Jade Green (Xanh Ngọc Thạch)',
    background: 'linear-gradient(180deg, #0a2e23 0%, #051d16 50%, #03140f 100%)',
    highlightColor: '#4ade80',
    accentBorder: '#22c55e',
    avatarGrad: 'linear-gradient(135deg, #16a34a, #14532d)',
  },
  {
    name: 'Dark Copper (Đồng Đỏ Trầm)',
    background: 'linear-gradient(180deg, #351a10 0%, #22100a 50%, #150a06 100%)',
    highlightColor: '#fb923c',
    accentBorder: '#ea580c',
    avatarGrad: 'linear-gradient(135deg, #b45309, #7c2d12)',
  },
  {
    name: 'Titanium Gray (Xám Titan Ánh Kim)',
    background: 'linear-gradient(180deg, #1e293b 0%, #131b27 50%, #0b0f17 100%)',
    highlightColor: '#38bdf8',
    accentBorder: '#0ea5e9',
    avatarGrad: 'linear-gradient(135deg, #475569, #1e293b)',
  },
  {
    name: 'Golden Bronze (Đồng Vàng Ánh Kim)',
    background: 'linear-gradient(180deg, #2a200b 0%, #1b1407 50%, #110d04 100%)',
    highlightColor: '#facc15',
    accentBorder: '#eab308',
    avatarGrad: 'linear-gradient(135deg, #a16207, #713f12)',
  },
  {
    name: 'Deep Olive (Xanh Rêu Quân Đội)',
    background: 'linear-gradient(180deg, #1e2610 0%, #13190a 50%, #0c1006 100%)',
    highlightColor: '#a3e635',
    accentBorder: '#84cc16',
    avatarGrad: 'linear-gradient(135deg, #4d7c0f, #365314)',
  },
  {
    name: 'Midnight Cobalt (Xanh Lam Đêm Muộn)',
    background: 'linear-gradient(180deg, #0f172a 0%, #080d19 50%, #020617 100%)',
    highlightColor: '#93c5fd',
    accentBorder: '#3b82f6',
    avatarGrad: 'linear-gradient(135deg, #1d4ed8, #0f172a)',
  },
  {
    name: 'Dark Amber (Hổ Phách Sẫm)',
    background: 'linear-gradient(180deg, #2e1b09 0%, #1d1105 50%, #120a03 100%)',
    highlightColor: '#f59e0b',
    accentBorder: '#d97706',
    avatarGrad: 'linear-gradient(135deg, #b45309, #78350f)',
  },
  {
    name: 'Smoky Quartz (Thạch Anh Khói)',
    background: 'linear-gradient(180deg, #202024 0%, #151518 50%, #0d0d10 100%)',
    highlightColor: '#e2e8f0',
    accentBorder: '#94a3b8',
    avatarGrad: 'linear-gradient(135deg, #64748b, #334155)',
  },
  {
    name: 'Burgundy Dusk (Đỏ Rượu Vang Trầm)',
    background: 'linear-gradient(180deg, #2e1114 0%, #1d090b 50%, #130608 100%)',
    highlightColor: '#fca5a5',
    accentBorder: '#ef4444',
    avatarGrad: 'linear-gradient(135deg, #991b1b, #450a0a)',
  },
  {
    name: 'Oceanic Slate (Xanh Xám Sóng Ngầm)',
    background: 'linear-gradient(180deg, #0f242c 0%, #09171c 50%, #050f13 100%)',
    highlightColor: '#2dd4bf',
    accentBorder: '#0d9488',
    avatarGrad: 'linear-gradient(135deg, #0f766e, #134e4a)',
  },
  {
    name: 'Dark Terracotta (Đất Nung Đêm Sẫm)',
    background: 'linear-gradient(180deg, #31170d 0%, #1f0e08 50%, #130905 100%)',
    highlightColor: '#fdba74',
    accentBorder: '#f97316',
    avatarGrad: 'linear-gradient(135deg, #c2410c, #7c2d12)',
  },
  {
    name: 'Nordic Shadow (Bóng Tối Bắc Âu)',
    background: 'linear-gradient(180deg, #151d28 0%, #0e131b 50%, #080c10 100%)',
    highlightColor: '#7dd3fc',
    accentBorder: '#0284c7',
    avatarGrad: 'linear-gradient(135deg, #0369a1, #0c4a6e)',
  },
  {
    name: 'Iron Carbon (Thép Carbon Đen Sâu)',
    background: 'linear-gradient(180deg, #14171a 0%, #0c0e10 50%, #070809 100%)',
    highlightColor: '#fcd34d',
    accentBorder: '#f59e0b',
    avatarGrad: 'linear-gradient(135deg, #4b5563, #111827)',
  },
];

/**
 * Gán mỗi Fanpage 1 màu sắc cố định dựa trên thuật toán băm (Deterministic Hash)
 * Giúp mỗi Page luôn giữ đúng 1 màu nhận diện thương hiệu đặc trưng nhất quán
 */
export function ztteam_getPageReelPalette(pageIdOrName?: string) {
  if (!pageIdOrName) return ZTTEAM_REEL_PALETTES[0];
  let hash = 0;
  for (let i = 0; i < pageIdOrName.length; i++) {
    hash = (hash << 5) - hash + pageIdOrName.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % ZTTEAM_REEL_PALETTES.length;
  return ZTTEAM_REEL_PALETTES[index];
}

/**
 * ZTTeam: 3 bộ tông màu điện ảnh cao cấp cho Text Story Reel (Tuyệt đối KHÔNG dùng màu Hồng/Tím)
 */
export const ZTTEAM_TEXT_STORY_THEMES = [
  {
    id: 'style1_cyan',
    name: 'Midnight Teal & Cyan',
    bgGradient: 'radial-gradient(ellipse at 85% 15%, #072635 0%, #030d15 45%, #010408 100%)',
    aura1: 'rgba(6, 182, 212, 0.55)',
    aura2: 'rgba(13, 148, 136, 0.60)',
    aura3: 'rgba(217, 119, 6, 0.40)',
    cardBg: 'rgba(6, 20, 32, 0.46)',
    cardBorder: '1.8px solid rgba(56, 189, 248, 0.35)',
    cardGlow: '0 32px 85px rgba(0, 0, 0, 0.88), 0 0 45px rgba(6, 182, 212, 0.22)',
    hookColor: '#fbbf24',
    hlColor: '#fbbf24',
    textColor: '#e2e8f0',
    ctaColor: '#38bdf8',
    verifiedColor: '#1877F2',
  },
  {
    id: 'style2_amber',
    name: 'Obsidian Bronze & Champagne Gold',
    bgGradient: 'radial-gradient(ellipse at 75% 20%, #2a1a08 0%, #0f0a04 45%, #030201 100%)',
    aura1: 'rgba(245, 158, 11, 0.52)',
    aura2: 'rgba(180, 83, 9, 0.60)',
    aura3: 'rgba(30, 41, 59, 0.65)',
    cardBg: 'rgba(24, 16, 9, 0.48)',
    cardBorder: '1.8px solid rgba(245, 158, 11, 0.38)',
    cardGlow: '0 32px 85px rgba(0, 0, 0, 0.9), 0 0 45px rgba(245, 158, 11, 0.25)',
    hookColor: '#fde047',
    hlColor: '#fde047',
    textColor: '#f1ede6',
    ctaColor: '#fbbf24',
    verifiedColor: '#1877F2',
  },
  {
    id: 'style3_cobalt',
    name: 'Deep Space Cobalt & Electric Cyan',
    bgGradient: 'radial-gradient(ellipse at 80% 25%, #0c204c 0%, #040c1e 45%, #01040c 100%)',
    aura1: 'rgba(37, 99, 235, 0.52)',
    aura2: 'rgba(14, 165, 233, 0.55)',
    aura3: 'rgba(30, 58, 138, 0.62)',
    cardBg: 'rgba(8, 18, 42, 0.46)',
    cardBorder: '1.8px solid rgba(96, 165, 250, 0.38)',
    cardGlow: '0 32px 85px rgba(0, 0, 0, 0.88), 0 0 45px rgba(37, 99, 235, 0.25)',
    hookColor: '#facc15',
    hlColor: '#facc15',
    textColor: '#e6edf5',
    ctaColor: '#60a5fa',
    verifiedColor: '#1877F2',
  },
];

export function ztteam_getTextStoryTheme(pageIdOrName?: string) {
  if (!pageIdOrName) return ZTTEAM_TEXT_STORY_THEMES[0];
  let hash = 0;
  for (let i = 0; i < pageIdOrName.length; i++) {
    hash = (hash << 5) - hash + pageIdOrName.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % ZTTEAM_TEXT_STORY_THEMES.length;
  return ZTTEAM_TEXT_STORY_THEMES[index];
}

@Injectable()
export class ZTTeamHookVideoService {
  private readonly logger = new Logger('ZTTeamHookVideoService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiService: ZTTeamAIService,
    private readonly bgmService: ZTTeamBgmService,
    private readonly telegramService: TelegramService,
    private readonly eventEmitter: EventEmitter2,
  ) { }

  /**
   * ZTTeam Concurrency Queue: Đảm bảo tối đa 1 video render tại một thời điểm
   * Ngăn chặn tình trạng nhiều tiến trình FFmpeg chạy đồng thời làm quá tải CPU/RAM trên VPS
   */
  private renderQueuePromise: Promise<any> = Promise.resolve();
  private queueLength = 0;

  /**
   * ZTTeam: Render video Reel 10s siêu sắc nét từ hình ảnh Hook hoặc Text Story kính mờ Frosted Glass
   * Đi qua hàng đợi tuần tự (FIFO Queue) an toàn
   */
  async ztteam_renderHookVideo(
    imageId: string,
    options?: { bgmFilename?: string; forceRegenHook?: boolean; videoEngine?: string }
  ): Promise<{ success: boolean; videoUrl?: string; error?: string }> {
    this.queueLength++;
    this.logger.log(`[HookVideoQueue] Nhận yêu cầu render video cho bài ${imageId} (Đang chờ trong hàng đợi: ${this.queueLength})`);

    const runJob = async () => {
      try {
        return await this.executeRenderHookVideo(imageId, options);
      } finally {
        this.queueLength--;
      }
    };

    const nextPromise = this.renderQueuePromise.then(runJob, runJob);
    this.renderQueuePromise = nextPromise.catch(() => {});
    return nextPromise;
  }

  /**
   * Thực thi render video thực tế (chạy đơn luồng thông qua hàng đợi tuần tự)
   */
  private async executeRenderHookVideo(
    imageId: string,
    options?: { bgmFilename?: string; forceRegenHook?: boolean; videoEngine?: string }
  ): Promise<{ success: boolean; videoUrl?: string; error?: string }> {
    this.logger.log(`===== START HOOK/TEXT STORY VIDEO RENDER: image=${imageId} =====`);

    const imageRecord = await this.prisma.ztteam_images.findUnique({
      where: { id: imageId },
      include: { page: true },
    });

    if (!imageRecord) {
      throw new Error(`Không tìm thấy bài viết ${imageId}`);
    }

    /** ZTTeam: Người dùng yêu cầu chỉ render bài CHƯA ĐĂNG, bài đã đăng rồi bỏ qua để tiết kiệm tài nguyên */
    if (imageRecord.is_posted && !options?.forceRegenHook) {
      this.logger.log(`Bài viết ${imageId} đã đăng lên Fanpage (is_posted = true), bỏ qua không render video.`);
      return { success: true, videoUrl: imageRecord.video_url || undefined };
    }

    /** Cập nhật trạng thái đang xử lý */
    await this.prisma.ztteam_images.update({
      where: { id: imageId },
      data: { video_status: 'PENDING', error_log: null },
    });
    this.eventEmitter.emit('image.updated', { id: imageId, video_status: 'PENDING' });

    const tempDir = path.join(ztteam_getImagesPath(imageId), 'temp_hook_render');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    let browser: any = null;

    try {
      const engine = options?.videoEngine || (imageRecord.page as any)?.video_engine || 'hook_image';

      /** 1. Chuẩn bị ảnh nguồn (đối với hook_image thì bắt buộc, text_story có thể linh hoạt) */
      const localImageCandidates = [
        path.join(ztteam_getImagesPath(imageId), 'output.png'),
        imageRecord.image_url ? path.join(process.cwd(), imageRecord.image_url.replace(/^\//, '')) : '',
        path.join(ztteam_getImagesPath(imageId), 'original.png'),
        path.join(ztteam_getSourceOriginalsPath(), `${imageRecord.wp_post_id}.jpg`),
      ].filter(p => p && fs.existsSync(p));

      let sourceImagePath = localImageCandidates[0];
      if (!sourceImagePath && engine !== 'text_story') {
        throw new Error('Không tìm thấy file ảnh gốc để render video');
      }

      /** 2. Chuẩn bị thông tin Fanpage */
      const pageName = imageRecord.page?.name || 'ZTTeam Daily Story';
      let pageAvatarDataUri = '';
      if (imageRecord.page?.avatar) {
        try {
          if (imageRecord.page.avatar.startsWith('data:image')) {
            pageAvatarDataUri = imageRecord.page.avatar;
          } else if (imageRecord.page.avatar.startsWith('http://') || imageRecord.page.avatar.startsWith('https://')) {
            /** Tải ảnh avatar từ URL (Facebook Graph API) và chuyển thành Base64 Data URI */
            const res = await axios.get(imageRecord.page.avatar, {
              responseType: 'arraybuffer',
              timeout: 8000,
              maxRedirects: 5,
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              },
            });
            const mimeType = res.headers['content-type'] || 'image/jpeg';
            const b64 = Buffer.from(res.data).toString('base64');
            pageAvatarDataUri = `data:${mimeType};base64,${b64}`;
          } else {
            const avatarLocal = path.join(process.cwd(), imageRecord.page.avatar.replace(/^\//, ''));
            if (fs.existsSync(avatarLocal)) {
              const avb64 = fs.readFileSync(avatarLocal).toString('base64');
              pageAvatarDataUri = `data:image/png;base64,${avb64}`;
            }
          }
        } catch (e: any) {
          this.logger.warn(`Không thể nạp avatar cho Fanpage "${pageName}": ${e?.message || e}`);
        }
      }

      /** =========================================================================
       * NHÁNH 1: ĐỊNH DẠNG TEXT STORY REEL (FROSTED GLASS CARD 9:16, ĐÁY CHỪA 10%)
       * ========================================================================= */
      if (engine === 'text_story') {
        const pageKey = imageRecord.page?.id || imageRecord.page?.name || imageRecord.page_id || 'ztteam_story';
        const theme = ztteam_getTextStoryTheme(pageKey);
        this.logger.log(`[Text Story Reel] Fanpage "${pageName}" sử dụng bộ theme: ${theme.name}`);

        const rawStory = imageRecord.ai_caption || imageRecord.wp_post_title || '';
        const storyData = await this.aiService.ztteam_generateTextStoryCardContent(
          imageRecord.wp_post_title || 'Compelling Story',
          rawStory
        );

        const wordCount = storyData.plainText.trim().split(/\s+/).length;
        let fontSize = 33.5;
        let lineHeight = 1.28;
        let pGap = 14;

        if (wordCount < 230) {
          fontSize = 35.5;
          lineHeight = 1.32;
          pGap = 16;
        } else if (wordCount > 290) {
          fontSize = 31.5;
          lineHeight = 1.24;
          pGap = 12;
        }

        const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@0,500;0,600;0,700;0,800;1,700&family=Montserrat:ital,wght@0,600;0,700;0,800&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      width: 1080px;
      height: 1920px;
      background: #020509;
      font-family: 'Barlow Condensed', sans-serif !important;
      color: #ffffff;
      overflow: hidden;
      position: relative;
    }

    /** NỀN TỐI SÂU DARK SEAMLESS ĐA LỚP GRADIENT */
    .bg-canvas {
      position: absolute;
      top: 0;
      left: 0;
      width: 1080px;
      height: 1920px;
      background: ${theme.bgGradient};
      z-index: 1;
    }

    /** QUẦNG SÁNG AURA 1 */
    .aura-1 {
      position: absolute;
      top: 60px;
      right: -80px;
      width: 820px;
      height: 820px;
      background: radial-gradient(circle, ${theme.aura1} 0%, transparent 70%);
      filter: blur(100px);
      z-index: 2;
      pointer-events: none;
    }

    /** QUẦNG SÁNG AURA 2 */
    .aura-2 {
      position: absolute;
      top: 600px;
      left: -140px;
      width: 800px;
      height: 800px;
      background: radial-gradient(circle, ${theme.aura2} 0%, transparent 70%);
      filter: blur(95px);
      z-index: 2;
      pointer-events: none;
    }

    /** QUẦNG SÁNG AURA 3 */
    .aura-3 {
      position: absolute;
      bottom: 80px;
      right: -100px;
      width: 840px;
      height: 840px;
      background: radial-gradient(circle, ${theme.aura3} 0%, transparent 70%);
      filter: blur(105px);
      z-index: 2;
      pointer-events: none;
    }

    /** HỌA TIẾT HẠT SÂU CINEMATIC */
    .noise-grid {
      position: absolute;
      top: 0;
      left: 0;
      width: 1080px;
      height: 1920px;
      background-image: radial-gradient(rgba(255, 255, 255, 0.035) 1px, transparent 1px);
      background-size: 30px 30px;
      z-index: 3;
      pointer-events: none;
    }

    /** CỤM FANPAGE HEADER NẰM TRỰC TIẾP TRÊN NỀN */
    .external-header {
      position: absolute;
      top: 68px;
      left: 60px;
      width: 960px;
      display: flex;
      align-items: center;
      gap: 16px;
      z-index: 10;
    }

    .avatar-wrapper {
      position: relative;
      width: 72px;
      height: 72px;
      flex-shrink: 0;
    }

    .page-avatar {
      width: 72px;
      height: 72px;
      border-radius: 50%;
      border: 2px solid ${theme.hookColor};
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.65);
      object-fit: cover;
    }

    .avatar-fallback {
      width: 72px;
      height: 72px;
      border-radius: 50%;
      border: 2px solid ${theme.hookColor};
      background: linear-gradient(135deg, #0e3e4b 0%, #061622 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 28px;
      font-weight: 800;
      color: #ffffff;
      font-family: 'Montserrat', sans-serif;
    }

    .header-meta {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .page-name-row {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    /** TÊN FANPAGE ĐƯỢC LÀM MỜ BLUR ĐÚNG CHUẨN VIRAL CENSOR */
    .page-name-blurred {
      font-family: 'Montserrat', sans-serif;
      font-size: 27px;
      font-weight: 800;
      color: #ffffff;
      letter-spacing: -0.3px;
      line-height: 1.15;
      filter: blur(5px);
      user-select: none;
    }

    .verified-icon {
      width: 20px;
      height: 20px;
      flex-shrink: 0;
    }

    .post-submeta {
      font-family: 'Montserrat', sans-serif;
      font-size: 18px;
      font-weight: 500;
      color: #94a3b8;
      letter-spacing: -0.2px;
    }

    /** THẺ BÀI VIẾT KÍNH MỜ (FROSTED GLASS) CAO 1575px, ĐÁY CHỈ CHỪA ĐÚNG ~10% (190px) */
    .glass-card-wrapper {
      position: absolute;
      top: 155px;
      left: 60px;
      width: 960px;
      height: 1575px;
      z-index: 10;
    }

    .glass-card {
      width: 100%;
      height: 100%;
      background: ${theme.cardBg};
      backdrop-filter: blur(36px);
      -webkit-backdrop-filter: blur(36px);
      border-radius: 36px;
      border: ${theme.cardBorder};
      box-shadow: ${theme.cardGlow}, inset 0 1px 2px rgba(255, 255, 255, 0.18);
      padding: 40px 46px 34px 46px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }

    .card-top-content {
      display: flex;
      flex-direction: column;
    }

    /** TIÊU ĐỀ MỞ MÀN CÂU CHUYỆN (VÀNG KIM NỔI BẬT) */
    .story-hook {
      font-family: 'Barlow Condensed', sans-serif;
      font-size: 44px;
      font-weight: 700;
      color: ${theme.hookColor};
      line-height: 1.20;
      margin-bottom: 18px;
      letter-spacing: -0.2px;
      text-shadow: 0 0 16px rgba(245, 158, 11, 0.4);
    }

    /** THÂN BÀI VIẾT TYPOGRAPHY BARLOW CONDENSED LẤP KÍN CARD */
    .story-body {
      display: flex;
      flex-direction: column;
      gap: ${pGap}px;
    }

    .story-p {
      font-family: 'Barlow Condensed', sans-serif;
      font-size: ${fontSize}px;
      font-weight: 600;
      line-height: ${lineHeight};
      color: ${theme.textColor};
      letter-spacing: -0.15px;
      text-shadow: 0 2px 4px rgba(0, 0, 0, 0.75);
    }

    /** TỪ KHÓA ĐẮT GIÁ HIGHLIGHT VÀNG KIM ÁNH SÁNG */
    .hl {
      color: ${theme.hlColor} !important;
      font-weight: 700;
      text-shadow: 0 0 12px rgba(245, 158, 11, 0.45);
    }

    /** NÚT KÊU GỌI HÀNH ĐỘNG CLIFFHANGER */
    .cta-row {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      width: 100%;
      padding-top: 12px;
    }

    .cta-text {
      font-family: 'Barlow Condensed', sans-serif;
      font-size: 37px;
      font-weight: 700;
      color: ${theme.ctaColor};
      text-shadow: 0 0 18px rgba(56, 189, 248, 0.7);
      letter-spacing: 0.3px;
    }
  </style>
</head>
<body>
  <div class="bg-canvas"></div>
  <div class="aura-1"></div>
  <div class="aura-2"></div>
  <div class="aura-3"></div>
  <div class="noise-grid"></div>

  <!-- HEADER FANPAGE (VỚI TÊN FANPAGE ĐƯỢC LÀM MỜ BLUR NHƯ ẢNH MẪU VIRAL) -->
  <div class="external-header">
    <div class="avatar-wrapper">
      ${pageAvatarDataUri 
        ? `<img src="${pageAvatarDataUri}" class="page-avatar" />`
        : `<div class="avatar-fallback">${pageName.substring(0, 2).toUpperCase()}</div>`
      }
    </div>
    <div class="header-meta">
      <div class="page-name-row">
        <span class="page-name-blurred">${pageName}</span>
        <svg class="verified-icon" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" fill="${theme.verifiedColor}"/>
          <path d="M7.5 12L10.5 15L16.5 9" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <span class="post-submeta">4 hours ago • A Text Story • facebook.com</span>
    </div>
  </div>

  <!-- THẺ BÀI VIẾT KÍNH MỜ FROSTED GLASS CAO 1575px - CHỈ TRỐNG ĐÚNG 10% Ở ĐÁY -->
  <div class="glass-card-wrapper">
    <div class="glass-card">
      <div class="card-top-content">
        <div class="story-hook">${storyData.hookQuote}</div>
        <div class="story-body">
          ${storyData.paragraphs.map(p => `<p class="story-p">${p}</p>`).join('\n          ')}
        </div>
      </div>
      <div class="cta-row">
        <div class="cta-text">Continue Reading...</div>
      </div>
    </div>
  </div>
</body>
</html>`;

        browser = await puppeteer.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
        const page = await browser.newPage();
        await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1 });
        await page.setContent(htmlContent, { waitUntil: 'load' });
        await page.evaluateHandle('document.fonts.ready');

        const framePngPath = path.join(tempDir, 'text_story_frame.png');
        await page.screenshot({ path: framePngPath, omitBackground: false, type: 'png' });
        await browser.close();
        browser = null;

        if (!fs.existsSync(framePngPath)) {
          throw new Error('Lỗi Puppeteer: File text_story_frame.png không được tạo thành công.');
        }

        const preferredBgm = options?.bgmFilename || imageRecord.page?.default_bgm || 'kiss_of_spring.mp4';
        const audioPath = this.bgmService.ztteam_resolveBgmPath(preferredBgm);

        const videosDir = ztteam_getVideosPath();
        if (!fs.existsSync(videosDir)) {
          fs.mkdirSync(videosDir, { recursive: true });
        }

        const timestamp = Date.now();
        const outputFilename = `text_story_reel_${imageId}_${timestamp}.mp4`;
        const outputVideoPath = path.join(videosDir, outputFilename);
        const duration = 10;

        const ffmpegCmd = `ffmpeg -y -threads 2 -loop 1 -t ${duration} -i "${framePngPath}" -t ${duration} -i "${audioPath}" -filter_complex "[0:v]scale='1080*(1+0.025*t/${duration})':-1:eval=frame:flags=bicubic,crop=1080:1920:(in_w-1080)/2:(in_h-1920)/2[vout];[1:a]atrim=0:${duration},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.5,afade=t=out:st=${duration - 1.5}:d=1.5,volume=0.85[aout]" -map "[vout]" -map "[aout]" -c:v libx264 -crf 20 -preset faster -pix_fmt yuv420p -r 30 -b:v 8M -maxrate 12M -bufsize 16M -c:a aac -b:a 192k -t ${duration} "${outputVideoPath}"`;

        await new Promise<void>((resolve, reject) => {
          exec(ffmpegCmd, { maxBuffer: 1024 * 1024 * 30 }, (error, stdout, stderr) => {
            if (error) {
              const cleanStderr = (stderr || error.message || '').trim();
              const lines = cleanStderr.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('ffmpeg version') && !l.startsWith('built with') && !l.startsWith('configuration:'));
              const actualError = lines.slice(-3).join(' | ') || error.message;
              this.logger.error(`FFmpeg text story render error: ${error.message}\n${cleanStderr}`);
              reject(new Error(actualError));
            } else {
              this.logger.log(`FFmpeg text story render completed: ${outputFilename}`);
              resolve();
            }
          });
        });

        const videoUrl = `/storage/videos/${outputFilename}`;

        const updated = await this.prisma.ztteam_images.update({
          where: { id: imageId },
          data: {
            video_url: videoUrl,
            video_status: 'COMPLETED',
            video_engine: 'text_story',
            video_created_at: new Date(),
            error_log: null,
          },
        });

        this.eventEmitter.emit('image.updated', updated);

        try {
          if (fs.existsSync(framePngPath)) fs.unlinkSync(framePngPath);
        } catch (e) { /** Bỏ qua */ }

        return { success: true, videoUrl };
      }

      /** =========================================================================
       * NHÁNH 2: ĐỊNH DẠNG HOOK IMAGE REEL (ẢNH 2K + 3 ĐOẠN HOOK MONTSERRAT)
       * ========================================================================= */
      const imageBase64 = fs.readFileSync(sourceImagePath).toString('base64');
      const imageExt = path.extname(sourceImagePath).replace('.', '') || 'png';
      const imageDataUri = `data:image/${imageExt};base64,${imageBase64}`;

      /** 3. Tạo kịch bản Hook 3 đoạn bám sát nội dung gốc bằng AI */
      let hookHtml = '';
      const rawStory = imageRecord.ai_caption || imageRecord.wp_post_title || '';

      const aiResult = await this.aiService.ztteam_generateReelHookStory(
        imageRecord.wp_post_title || 'Compelling Mystery Story',
        rawStory
      );
      hookHtml = aiResult.hookHtml;

      /** 4. Tính toán Dynamic Typography dựa trên tổng số từ để căn chuẩn tuyệt đối */
      const plainText = hookHtml.replace(/<[^>]*>?/gm, '');
      const wordCount = plainText.trim().split(/\s+/).length;

      let fontSize = 36;
      let lineMarginBottom = 24;
      let textLineHeight = 1.48;

      if (wordCount <= 65) {
        fontSize = 38;
        lineMarginBottom = 26;
        textLineHeight = 1.5;
      } else if (wordCount > 90) {
        fontSize = 32;
        lineMarginBottom = 20;
        textLineHeight = 1.42;
      }

      /** 5. Xác định màu sắc cố định cho Fanpage nhận bài và Render Canvas qua Puppeteer */
      const pageKey = imageRecord.page?.id || imageRecord.page?.name || imageRecord.page_id || '';
      const pal = ztteam_getPageReelPalette(pageKey);
      this.logger.log(`[Reel Theme] Fanpage "${imageRecord.page?.name || 'Mặc định'}" sử dụng bộ màu cố định: ${pal.name}`);

      const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Montserrat:ital,wght@0,400;0,600;0,700;0,800;0,900;1,700;1,900&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      width: 1080px;
      height: 1920px;
      background: transparent;
      font-family: 'Montserrat', sans-serif !important;
      color: #ffffff;
      overflow: hidden;
      position: relative;
    }

    /** VÙNG TRÊN 40.5% (774px) TRONG SUỐT ĐỂ LỘ VIDEO KEN BURNS ZOOM BÊN DƯỚI */
    .top-transparent-window {
      position: absolute;
      top: 0;
      left: 0;
      width: 1080px;
      height: 774px;
      background: transparent;
    }

    /** NỀN TỐI SANG TRỌNG KÉO DÀI 1146px XUỐNG ĐÁY */
    .section-bottom-seamless {
      position: absolute;
      top: 774px;
      left: 0;
      width: 1080px;
      height: 1146px;
      background: ${pal.background};
    }

    /** KHUNG NỘI DUNG */
    .content-container {
      position: absolute;
      top: 774px;
      left: 0;
      width: 1080px;
      height: 1146px;
      display: flex;
      flex-direction: column;
      align-items: center;
      z-index: 10;
    }

    /** FANPAGE HEADER */
    .fanpage-header-row {
      width: 950px;
      margin-top: 36px;
      display: flex;
      align-items: center;
      gap: 22px;
    }

    .fanpage-avatar {
      width: 86px;
      height: 86px;
      border-radius: 50%;
      background: ${pal.avatarGrad};
      border: 3.5px solid ${pal.accentBorder};
      box-shadow: 0 4px 18px rgba(0, 0, 0, 0.45);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 34px;
      font-weight: 800;
      color: #ffffff;
      letter-spacing: -0.5px;
      flex-shrink: 0;
      object-fit: cover;
    }

    .fanpage-meta {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .fanpage-name {
      font-size: 38px;
      font-weight: 800;
      color: #ffffff;
      letter-spacing: -0.5px;
      line-height: 1.15;
    }

    .fanpage-subtitle {
      font-size: 22px;
      font-weight: 500;
      color: #8ea5b0;
      line-height: 1.2;
    }

    /** ĐƯỜNG KẺ CHỈ VÀNG MẠ THANH MẢNH TRÊN */
    .gold-divider-top {
      width: 950px;
      height: 2px;
      margin-top: 24px;
      margin-bottom: 26px;
      background: linear-gradient(90deg, rgba(243,195,91,0.15) 0%, ${pal.accentBorder} 20%, ${pal.accentBorder} 80%, rgba(243,195,91,0.15) 100%);
      box-shadow: 0 0 10px rgba(243, 195, 91, 0.3);
    }

    /** HOOK BODY TYPOGRAPHY (MONTSERRAT 36px CĂN TRÁI) */
    .hook-body {
      width: 950px;
      display: flex;
      flex-direction: column;
    }

    .hook-p {
      font-size: ${fontSize}px;
      font-weight: 600;
      line-height: ${textLineHeight};
      color: #ffffff;
      text-align: left;
      letter-spacing: -0.2px;
      margin-bottom: ${lineMarginBottom}px;
      text-shadow: 0 2px 8px rgba(0, 0, 0, 0.7);
    }

    .hook-p:last-child {
      margin-bottom: 0;
    }

    .hl {
      color: ${pal.highlightColor} !important;
      font-weight: 800;
      text-shadow: 0 0 14px rgba(243, 195, 91, 0.35);
    }

    /** ĐƯỜNG KẺ CHỈ VÀNG MẠ THANH MẢNH DƯỚI */
    .gold-divider-bottom {
      width: 950px;
      height: 2px;
      margin-top: 6px;
      background: linear-gradient(90deg, rgba(243,195,91,0.15) 0%, ${pal.accentBorder} 20%, ${pal.accentBorder} 80%, rgba(243,195,91,0.15) 100%);
      box-shadow: 0 0 10px rgba(243, 195, 91, 0.3);
    }

    /** KHOẢNG ĐỆM TRÁNH NÚT REELS UI FACEBOOK */
    .reels-ui-bottom-spacer {
      height: 180px;
      width: 100%;
    }
  </style>
</head>
<body>
  <div class="top-transparent-window"></div>
  <div class="section-bottom-seamless"></div>

  <div class="content-container">
    <div class="fanpage-header-row">
      ${pageAvatarDataUri
          ? `<img src="${pageAvatarDataUri}" class="fanpage-avatar">`
          : `<div class="fanpage-avatar">${pageName.substring(0, 2).toUpperCase()}</div>`
        }
      <div class="fanpage-meta">
        <div class="fanpage-name">${pageName}</div>
        <div class="fanpage-subtitle">Facebook Creator • Viral Stories</div>
      </div>
    </div>

    <div class="gold-divider-top"></div>

    <div class="hook-body">
      ${aiResult.paragraphs.map(p => `<p class="hook-p">${p}</p>`).join('\n      ')}
    </div>

    <div class="gold-divider-bottom"></div>
    <div class="reels-ui-bottom-spacer"></div>
  </div>
</body>
</html>`;

      browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
      const page = await browser.newPage();
      await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1 });
      await page.setContent(htmlContent, { waitUntil: 'load' });
      await page.evaluateHandle('document.fonts.ready');

      const overlayPngPath = path.join(tempDir, 'frame_overlay.png');
      await page.screenshot({ path: overlayPngPath, omitBackground: true, type: 'png' });
      await browser.close();
      browser = null;

      if (!fs.existsSync(overlayPngPath)) {
        throw new Error('Lỗi Puppeteer: File frame_overlay.png không được tạo thành công.');
      }

      /** 6. Lấy file nhạc nền BGM từ thư viện */
      const preferredBgm = options?.bgmFilename || imageRecord.page?.default_bgm;
      const audioPath = this.bgmService.ztteam_resolveBgmPath(preferredBgm);

      /** 7. Render Video bằng FFmpeg với Cinematic Ken Burns Zoom (1.0 -> 1.035) chuẩn từ test_render_sharp_reel_video.js */
      const videosDir = ztteam_getVideosPath();
      if (!fs.existsSync(videosDir)) {
        fs.mkdirSync(videosDir, { recursive: true });
      }

      const timestamp = Date.now();
      const outputFilename = `hook_reel_${imageId}_${timestamp}.mp4`;
      const outputVideoPath = path.join(videosDir, outputFilename);
      const duration = 10;

      const ffmpegCmd = `ffmpeg -y -threads 2 -loop 1 -t ${duration} -i "${sourceImagePath}" -loop 1 -t ${duration} -i "${overlayPngPath}" -t ${duration} -i "${audioPath}" -filter_complex "[0:v]scale=1080:774:force_original_aspect_ratio=increase,crop=1080:774:(in_w-1080)/2:(in_h-774)/2,scale='1080*(1+0.035*t/${duration})':-1:eval=frame:flags=bicubic,crop=1080:774:(in_w-1080)/2:(in_h-774)/2[fg];color=c=#011114:s=1080x1920:d=${duration}[base];[base][fg]overlay=0:0[with_img];[with_img][1:v]overlay=0:0[vout];[2:a]atrim=0:${duration},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.4,afade=t=out:st=${duration - 1.5}:d=1.5,volume=0.9[aout]" -map "[vout]" -map "[aout]" -c:v libx264 -crf 20 -preset faster -pix_fmt yuv420p -r 30 -b:v 8M -maxrate 12M -bufsize 16M -c:a aac -b:a 192k -t ${duration} "${outputVideoPath}"`;

      await new Promise<void>((resolve, reject) => {
        exec(ffmpegCmd, { maxBuffer: 1024 * 1024 * 30 }, (error, stdout, stderr) => {
          if (error) {
            const cleanStderr = (stderr || error.message || '').trim();
            const lines = cleanStderr.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('ffmpeg version') && !l.startsWith('built with') && !l.startsWith('configuration:'));
            const actualError = lines.slice(-3).join(' | ') || error.message;
            this.logger.error(`FFmpeg render error: ${error.message}\n${cleanStderr}`);
            reject(new Error(actualError));
          } else {
            this.logger.log(`FFmpeg render completed: ${outputFilename}`);
            resolve();
          }
        });
      });

      const videoUrl = `/storage/videos/${outputFilename}`;

      /** 8. Cập nhật kết quả vào database */
      const updated = await this.prisma.ztteam_images.update({
        where: { id: imageId },
        data: {
          video_url: videoUrl,
          video_status: 'COMPLETED',
          video_engine: 'hook_image',
          video_created_at: new Date(),
          error_log: null,
        },
      });

      this.eventEmitter.emit('image.updated', updated);

      /** Dọn dẹp frame tạm */
      try {
        if (fs.existsSync(overlayPngPath)) fs.unlinkSync(overlayPngPath);
      } catch (e) {
        /** Bỏ qua */
      }

      return { success: true, videoUrl };
    } catch (err: any) {
      this.logger.error(`Hook video render failed for ${imageId}: ${err.message}`);
      if (browser) {
        try { await browser.close(); } catch (e) { /** Bỏ qua */ }
      }

      await this.prisma.ztteam_images.update({
        where: { id: imageId },
        data: {
          video_status: 'FAILED',
          error_log: `Hook Render Error: ${err.message}`,
        },
      });

      this.eventEmitter.emit('image.updated', { id: imageId, video_status: 'FAILED' });

      /** Gửi thông báo lỗi chi tiết qua Telegram cho Admin */
      try {
        const extractedError = ztteam_extractErrorMessage(err);
        const postTitle = imageRecord?.wp_post_title || 'Bài viết #' + imageId;
        const pageTitle = imageRecord?.page?.name || 'Chưa gán Fanpage';
        const teleMessage = this.telegramService.ztteam_formatAlert({
          systemName: 'Render Video Hook (FFmpeg / AI)',
          fanpageName: pageTitle,
          postTitle,
          step: /openai|gpt|gemini|google|deepseek|ai/i.test(extractedError)
            ? 'Bước 1/2: Tạo kịch bản 3 đoạn hook bằng AI'
            : 'Bước 2/2: Ghép phụ đề, hiệu ứng Ken Burns & lồng nhạc nền bằng FFmpeg',
          rawError: extractedError,
          nextAction: 'Hệ thống đã tự động bỏ qua video này và tiếp tục xử lý các bài tiếp theo.',
        });
        await this.telegramService.ztteam_sendMessage(teleMessage);
      } catch (teleErr) {
        /** Bỏ qua nếu lỗi gửi Telegram */
      }

      return { success: false, error: ztteam_extractErrorMessage(err) };
    }
  }
}
