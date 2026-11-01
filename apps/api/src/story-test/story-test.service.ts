import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ZTTeamAIService } from '../ai/ai.service';
import { ZTTeamFFmpegService } from '../media/ffmpeg.service';
import { ZTTeamFetcherService } from '../crawler/fetcher.service';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import * as path from 'path';
import * as fs from 'fs';
import { ztteam_getStorageRoot } from '../common/ztteam_storage.util';
import { PrismaService } from '../prisma/prisma.service';

export interface ZTTeamStorySegment {
  start: number;
  end: number;
  text: string;
}

export interface ZTTeamStoryTeaserScriptResult {
  hook_en: string;
  segments_en: ZTTeamStorySegment[];
  caption_en: string;
  preview_vi: {
    tieu_de: string;
    tom_tat: string;
    segments_dich: ZTTeamStorySegment[];
  };
}

export interface ZTTeamStorySingleImagePromptResult {
  scene_desc_vi: string;
  image_prompt_en: string;
  caption_en: string;
  first_comment: string;
  aspect_ratio: '4:5' | '1:1' | '16:9';
}

export interface ZTTeamStorySingleImageResult {
  imageUrl: string;
  localPath: string;
  prompt: string;
  seed: number;
  width: number;
  height: number;
  aspect_ratio: string;
}

@Injectable()
export class ZTTeamStoryTestService {
  private readonly logger = new Logger(ZTTeamStoryTestService.name);

  constructor(
    private readonly aiService: ZTTeamAIService,
    private readonly ffmpegService: ZTTeamFFmpegService,
    private readonly fetcherService: ZTTeamFetcherService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Return available offline background music tracks
   */
  ztteam_getBgmList() {
    return [
      {
        id: 'suspense_dramatic.mp3',
        name: 'Hồi hộp / Kịch tính (Suspense Dramatic)',
        mood: 'suspense',
      },
      {
        id: 'mystery_deep.mp3',
        name: 'Bí ẩn / Rùng rợn (Deep Mystery)',
        mood: 'mystery',
      },
      {
        id: 'emotional_story.mp3',
        name: 'Cảm xúc / Trầm lắng (Emotional Story)',
        mood: 'emotional',
      },
    ];
  }

  /**
   * Return sample long stories for one-click testing
   */
  ztteam_getSampleStories() {
    return [
      {
        id: 'story_1',
        title: 'Bức thư kỳ lạ dưới sàn nhà gỗ 100 năm tuổi',
        content: `Một cặp vợ chồng trẻ vừa mua lại một căn nhà cổ được xây dựng từ năm 1920 ở vùng ngoại ô. Trong lúc sửa chữa phòng khách để lát lại sàn gỗ, người chồng bất ngờ phát hiện một khoảng trống bí mật bên dưới thanh xà gỗ mục nát. Bên trong là một chiếc hộp sắt gỉ sét được bọc kín bằng vải dầu.
Khi cạy nắp chiếc hộp, họ tìm thấy một cuốn nhật ký viết tay đã ngả vàng cùng một bức ảnh đen trắng chụp một gia đình 4 người. Những dòng nhật ký đầu tiên ghi lại cuộc sống bình dị, nhưng càng về sau, nét chữ càng trở nên run rẩy và hoảng loạn.
Trang nhật ký ngày 14 tháng 10 năm 1935 có ghi: 'Nó không phải là tiếng gió. Nó đang bước đi trong những bức tường. Nếu ai tìm thấy cuốn sổ này, xin đừng mở căn hầm phía sau lò sưởi...'. Người vợ tò mò soi đèn pin vào phía sau bức tường lò sưởi cũ kỹ và phát hiện một tay nắm cửa sắt đã bị chôn vùi hàng thập kỷ...`,
        images: [
          'https://images.unsplash.com/photo-1518780664697-55e3ad937233?w=1080&h=1920&fit=crop',
          'https://images.unsplash.com/photo-1509114397022-ed747cca3f65?w=1080&h=1920&fit=crop',
          'https://images.unsplash.com/photo-1513694203232-719a280e022f?w=1080&h=1920&fit=crop',
        ],
      },
      {
        id: 'story_2',
        title: 'Chuyến xe buýt đêm số 404 và vị khách bí ẩn',
        content: `Đã 12 giờ đêm, trời mưa tầm tã. Bác tài xế Minh lái chuyến xe buýt cuối cùng về bến vắng. Trên xe chỉ còn lại một hành khách duy nhất ngồi ở hàng ghế cuối: một cô gái mặc áo khoác vàng, cúi gằm mặt không nhìn lên suốt chặng đường dài.
Khi xe đến trạm dừng gần một nghĩa trang cũ, cô gái bấm chuông xin xuống. Lúc cô bước ngang qua buồng lái để trả tiền vé, bác Minh giật mình nhận ra bàn tay của cô lạnh ngắt như đá và chiếc bóng dưới chân cô dường như không cử động theo ánh đèn đường.
Sáng hôm sau, khi kiểm tra camera giám sát trong buồng lái, bác Minh bàng hoàng phát hiện suốt chuyến xe đêm qua... hàng ghế cuối hoàn toàn trống rỗng, và trên sàn xe nơi cô gái đứng chỉ còn lại một tấm vé xe đề ngày của 15 năm trước.`,
        images: [
          'https://images.unsplash.com/photo-1544620347-c4fd4a3d5957?w=1080&h=1920&fit=crop',
          'https://images.unsplash.com/photo-1519501025264-65ba15a82390?w=1080&h=1920&fit=crop',
          'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?w=1080&h=1920&fit=crop',
        ],
      },
    ];
  }

  /**
   * Generate bilingual story teaser script using AI (Gemini, OpenAI, DeepSeek, or graceful fallback)
   * Outputs English on-screen text + Vietnamese translation preview
   */
  async ztteam_generateScript(
    content: string,
    durationSeconds: number = 15,
    tone: string = 'suspense',
  ): Promise<ZTTeamStoryTeaserScriptResult> {
    const validDuration = [10, 15, 20, 30].includes(durationSeconds) ? durationSeconds : 15;
    this.logger.log(`Generating Story Teaser Script (duration: ${validDuration}s, tone: ${tone})`);

    const settings = await (this.aiService as any).getSettings();
    const geminiKey = settings.geminiKey || process.env.GEMINI_API_KEY;
    const openaiKey = settings.openaiKey || process.env.OPENAI_API_KEY;
    const deepseekKey = settings.deepseekKey || process.env.DEEPSEEK_API_KEY;

    /** Compute recommended segment count based on duration */
    let timingInstructions = '';
    if (validDuration === 10) {
      timingInstructions = `Total duration is 10 seconds. Divide into 2 segments:
- Segment 1: 0 to 5s (Shocking Hook)
- Segment 2: 5 to 10s (Climax / Cliffhanger + Call to Action for comment link)`;
    } else if (validDuration === 15) {
      timingInstructions = `Total duration is 15 seconds. Divide into 3 segments:
- Segment 1: 0 to 5s (Dramatic Hook)
- Segment 2: 5 to 10s (Rising Climax)
- Segment 3: 10 to 15s (Shocking Cliffhanger + Call to Action for comment link)`;
    } else if (validDuration === 20) {
      timingInstructions = `Total duration is 20 seconds. Divide into 4 segments:
- Segment 1: 0 to 5s (Hook)
- Segment 2: 5 to 10s (Plot Twist)
- Segment 3: 10 to 15s (Climax)
- Segment 4: 15 to 20s (Cliffhanger + Call to Action for comment link)`;
    } else {
      timingInstructions = `Total duration is 30 seconds. Divide into 5 segments:
- Segment 1: 0 to 6s (Hook)
- Segment 2: 6 to 12s (Plot Tension)
- Segment 3: 12 to 18s (Sudden Revelation)
- Segment 4: 18 to 24s (Extreme Climax)
- Segment 5: 24 to 30s (Cliffhanger + Call to Action for comment link)`;
    }

    const systemPrompt = `You are a world-class viral video teaser scriptwriter specializing in mystery, suspense, and thriller stories.
Your task is to analyze the provided long story and write an intense, high-converting VIDEO TEASER that drives viewers to read the full story in the comments.

CRITICAL RULES:
1. Video On-Screen Content MUST BE IN ENGLISH:
   - Each segment text must be SHORT, PUNCHY, and IMPACTFUL (5 to 10 English words per segment).
   - Use simple, dramatic vocabulary that is easy to read fast on screen.
   - The final segment MUST contain a cliffhanger and a clear CTA directing viewers to the comment link (e.g. "What happened next? Read full story in the comments below!").
2. Timing Alignment:
   ${timingInstructions}
   - The sum of all segment durations must equal exactly ${validDuration} seconds.
3. Bilingual Review Requirement:
   - You MUST also provide a Vietnamese preview object containing:
     * tieu_de: Title in Vietnamese.
     * tom_tat: A 2-sentence summary of the story in Vietnamese so the admin can review the context.
     * segments_dich: Direct Vietnamese translation for each English segment.
4. Output Format:
   - Return ONLY a valid JSON object matching the exact structure below. No markdown backticks, no explanations.

JSON SCHEMA:
{
  "hook_en": "Short suspense hook title in English (under 7 words)",
  "segments_en": [
    { "start": 0, "end": 5, "text": "English line 1" }
  ],
  "caption_en": "Compelling Facebook post caption in English with hashtags and CTA to read full story in comments.",
  "preview_vi": {
    "tieu_de": "Tiêu đề tiếng Việt",
    "tom_tat": "Tóm tắt cốt truyện tiếng Việt 2 câu",
    "segments_dich": [
      { "start": 0, "end": 5, "text": "Lời dịch tiếng Việt tương ứng" }
    ]
  }
}`;

    const userContent = `Analyze this story and generate the ${validDuration}s teaser:\n\n${content.substring(0, 25000)}`;

    let rawJsonText = '';

    try {
      if (geminiKey) {
        this.logger.log('Using Gemini 3.5 Flash Lite for Story Teaser generation');
        const genAI = new GoogleGenerativeAI(geminiKey);
        const model = genAI.getGenerativeModel({
          model: 'gemini-3.5-flash-lite',
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.75,
            maxOutputTokens: 2000,
          },
        });
        const result = await model.generateContent(`${systemPrompt}\n\n${userContent}`);
        rawJsonText = result.response.text();
      } else if (openaiKey) {
        this.logger.log('Using OpenAI gpt-4o-mini for Story Teaser generation');
        const openai = new OpenAI({ apiKey: openaiKey });
        const res = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.75,
        });
        rawJsonText = res.choices[0]?.message?.content || '{}';
      } else if (deepseekKey) {
        this.logger.log('Using DeepSeek deepseek-chat for Story Teaser generation');
        const openai = new OpenAI({ apiKey: deepseekKey, baseURL: 'https://api.deepseek.com' });
        const res = await openai.chat.completions.create({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.75,
        });
        rawJsonText = res.choices[0]?.message?.content || '{}';
      } else {
        this.logger.warn('No AI API Key found (Gemini / OpenAI / DeepSeek). Using fallback demo teaser script.');
        return this.ztteam_getMockTeaserScript(content, validDuration);
      }

      const parsed = JSON.parse(rawJsonText);
      return {
        hook_en: parsed.hook_en || 'Shocking Mystery Story',
        segments_en: Array.isArray(parsed.segments_en) ? parsed.segments_en : [],
        caption_en: parsed.caption_en || 'Read the shocking full story in the comments below!',
        preview_vi: parsed.preview_vi || {
          tieu_de: 'Câu chuyện bí ẩn',
          tom_tat: 'Tóm tắt nội dung câu chuyện.',
          segments_dich: [],
        },
      };
    } catch (e: any) {
      this.logger.error(`AI generation error: ${e.message}. Falling back to demo teaser script.`);
      const mockResult = this.ztteam_getMockTeaserScript(content, validDuration);
      mockResult.preview_vi.tom_tat = `[Lưu ý: API AI gặp lỗi (${e.message}) - Đã tự động tạo kịch bản demo mẫu để bạn tiếp tục test render video].`;
      return mockResult;
    }
  }

  /**
   * Built-in fallback mock teaser script generator
   */
  private ztteam_getMockTeaserScript(content: string, duration: number): ZTTeamStoryTeaserScriptResult {
    if (duration === 10) {
      return {
        hook_en: 'The Unthinkable Secret',
        segments_en: [
          { start: 0, end: 5, text: 'A secret buried for nearly a century was finally exposed.' },
          { start: 5, end: 10, text: 'What was found inside? Read the full shocking story in comments!' },
        ],
        caption_en: `Some secrets should have remained buried forever... 🚨 Read the full story pinned in the first comment! #mystery #truestory #horror`,
        preview_vi: {
          tieu_de: 'Bí Mật Khó Tin',
          tom_tat: 'Câu chuyện mở ra bí mật kinh hoàng được giấu kín gần một thế kỷ.',
          segments_dich: [
            { start: 0, end: 5, text: 'Một bí mật bị chôn giấu suốt gần một thế kỷ cuối cùng đã lộ ra.' },
            { start: 5, end: 10, text: 'Thứ gì ở bên trong? Đọc toàn bộ câu chuyện gây sốc ở phần bình luận!' },
          ],
        },
      };
    } else if (duration === 15) {
      return {
        hook_en: 'Never Open That Door',
        segments_en: [
          { start: 0, end: 5, text: 'They thought they bought a normal house until they lifted the floor.' },
          { start: 5, end: 10, text: 'Inside sat a rusted 1920 iron box with a chilling warning.' },
          { start: 10, end: 15, text: 'What happened when they opened it? Read full story in the comments!' },
        ],
        caption_en: `They found something behind the wall that changed everything... 😱 Read full story pinned in the first comment! #viralstory #suspense #creepystories`,
        preview_vi: {
          tieu_de: 'Đừng Bao Giờ Mở Cánh Cửa Đó',
          tom_tat: 'Cặp đôi phát hiện chiếc hộp sắt rỉ sét năm 1920 với lời cảnh báo rùng rợn dưới sàn nhà.',
          segments_dich: [
            { start: 0, end: 5, text: 'Họ nghĩ rằng mình mua một ngôi nhà bình thường cho đến khi dỡ tấm sàn lên.' },
            { start: 5, end: 10, text: 'Bên trong là chiếc hộp sắt 1920 rỉ sét kèm lời cảnh báo ớn lạnh.' },
            { start: 10, end: 15, text: 'Chuyện gì xảy ra khi họ mở nó? Đọc toàn bộ câu chuyện ở phần bình luận!' },
          ],
        },
      };
    } else if (duration === 20) {
      return {
        hook_en: 'The Attic Mystery',
        segments_en: [
          { start: 0, end: 5, text: 'Every midnight, strange footsteps echoed right above her bedroom.' },
          { start: 5, end: 10, text: 'She climbed the attic stairs with only a trembling flashlight.' },
          { start: 10, end: 15, text: 'A small wooden doll was sitting in the exact center of the room.' },
          { start: 15, end: 20, text: 'Then the attic door slammed shut behind her! Full story in comments.' },
        ],
        caption_en: `She was home alone, or so she thought... 🕯️ Find out what happened in the comments below! #thriller #ghoststory #mystery`,
        preview_vi: {
          tieu_de: 'Bí Ẩn Căn Gác Mái',
          tom_tat: 'Những tiếng bước chân bí ẩn mỗi đêm trên gác mái dẫn tới một phát hiện rùng mình.',
          segments_dich: [
            { start: 0, end: 5, text: 'Mỗi nửa đêm, tiếng bước chân lạ vang lên ngay phía trên trần phòng ngủ.' },
            { start: 5, end: 10, text: 'Cô run rẩy bước lên cầu thang gác mái chỉ với một chiếc đèn pin.' },
            { start: 10, end: 15, text: 'Một con búp bê gỗ đang ngồi ngay chính giữa căn phòng trống.' },
            { start: 15, end: 20, text: 'Bất ngờ cánh cửa gác mái đóng sập lại phía sau! Đọc tiếp ở bình luận.' },
          ],
        },
      };
    } else {
      return {
        hook_en: 'The Forbidden Island',
        segments_en: [
          { start: 0, end: 6, text: 'An abandoned island untouched by human civilization for decades.' },
          { start: 6, end: 12, text: 'A team of three researchers ventured inside to investigate the signal.' },
          { start: 12, end: 18, text: 'Deep within the underground bunker, the radio suddenly crackled to life.' },
          { start: 18, end: 24, text: 'A voice whispered their exact names and told them to run immediately.' },
          { start: 24, end: 30, text: 'Only one of them ever returned. Read the horrifying true story in comments!' },
        ],
        caption_en: `What really happened on that forbidden island? 🗺️ Read the complete investigation in the pinned comment below! #unexplained #expedition #mystery`,
        preview_vi: {
          tieu_de: 'Hòn Đảo Bị Cấm Đoán',
          tom_tat: 'Nhóm nghiên cứu thám hiểm hòn đảo hoang và nhận tín hiệu cảnh báo từ boong-ke ngầm.',
          segments_dich: [
            { start: 0, end: 6, text: 'Một hòn đảo hoang vắng chưa từng có dấu chân người suốt nhiều thập kỷ.' },
            { start: 6, end: 12, text: 'Nhóm 3 nhà nghiên cứu tiến vào rừng sâu để điều tra nguồn phát tín hiệu.' },
            { start: 12, end: 18, text: 'Sâu trong boong-ke ngầm, máy radio bỗng rè lên và phát ra âm thanh.' },
            { start: 18, end: 24, text: 'Một giọng thì thầm đọc chính xác tên của họ và ra lệnh phải chạy ngay.' },
            { start: 24, end: 30, text: 'Chỉ có duy nhất một người sống sót trở về. Đọc tiếp ở phần bình luận!' },
          ],
        },
      };
    }
  }

  /**
   * Render an isolated test video using FFmpeg
   * Combines Slideshow + BGM Audio + English ASS Subtitles + CTA Banner
   */
  async ztteam_renderVideo(params: {
    scriptData: ZTTeamStoryTeaserScriptResult;
    duration: number;
    images?: string[];
    bgmTrack?: string;
  }): Promise<{ videoUrl: string; thumbnailUrl: string; duration: number }> {
    const { scriptData, duration = 15, images = [], bgmTrack = 'suspense_dramatic.mp3' } = params;
    const validDuration = [10, 15, 20, 30].includes(duration) ? duration : 15;

    const jobId = `story_test_${Date.now()}`;
    const storageRoot = ztteam_getStorageRoot();
    const workDir = path.join(storageRoot, 'story-test', jobId);
    fs.mkdirSync(workDir, { recursive: true });

    this.logger.log(`Starting isolated Story Teaser render: jobId=${jobId}, duration=${validDuration}s`);

    /** 1. Prepare Images */
    let sourceImages = images.length > 0 ? images : [
      'https://images.unsplash.com/photo-1518780664697-55e3ad937233?w=1080&h=1920&fit=crop',
      'https://images.unsplash.com/photo-1509114397022-ed747cca3f65?w=1080&h=1920&fit=crop',
    ];

    const preparedImages: string[] = [];
    for (let i = 0; i < sourceImages.length; i++) {
      const imgPath = path.join(workDir, `img_${i}.jpg`);
      await this.ztteam_downloadOrCopyImage(sourceImages[i], imgPath);

      const prepPath = path.join(workDir, `prep_${i}.jpg`);
      await this.ffmpegService.ztteam_prepareImage(imgPath, prepPath, 1080, 1920, 0, 0);
      preparedImages.push(prepPath);
    }

    /** 2. Create Slideshow Video */
    const slideshowPath = path.join(workDir, 'slideshow.mp4');
    await this.ffmpegService.ztteam_createSlideshow(preparedImages, validDuration, slideshowPath, 1080, 1920);

    /** 3. Prepare BGM Audio with Fade-Out */
    const bgmFileName = bgmTrack || 'suspense_dramatic.mp3';
    const bgmSourcePath = path.join(process.cwd(), 'apps', 'api', 'assets', 'bgm', bgmFileName);
    const bgmTrimmedPath = path.join(workDir, 'bgm.mp3');

    if (fs.existsSync(bgmSourcePath)) {
      const fadeStart = Math.max(1, validDuration - 1.5);
      const cutCmd = `ffmpeg -y -i "${bgmSourcePath}" -t ${validDuration} -af "afade=t=out:st=${fadeStart}:d=1.5,volume=0.85" -c:a libmp3lame -b:a 192k "${bgmTrimmedPath}"`;
      await (this.ffmpegService as any).ztteam_runFfmpeg(cutCmd, 15000);
    } else {
      /** Fallback silent/tone audio */
      const silentCmd = `ffmpeg -y -f lavfi -i "sine=frequency=110:duration=${validDuration}" -af "volume=0.2" -c:a libmp3lame "${bgmTrimmedPath}"`;
      await (this.ffmpegService as any).ztteam_runFfmpeg(silentCmd, 15000);
    }

    /** 4. Generate ASS Subtitle File for English Story Text */
    const subtitlePath = path.join(workDir, 'subtitles.ass');
    const assContent = this.ztteam_buildAssSubtitles(scriptData.segments_en, validDuration);
    fs.writeFileSync(subtitlePath, assContent, 'utf-8');

    /** 5. Final Merge (Slideshow + BGM + Subtitles) */
    const outputPath = path.join(workDir, 'output.mp4');
    /** Escape colon and backslashes for FFmpeg subtitles filter on Windows */
    const escapedAssPath = subtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:');
    const fontsDir = path.join(process.cwd(), 'apps', 'api', 'assets').replace(/\\/g, '/').replace(/:/g, '\\:');

    const mergeCmd = `ffmpeg -y -i "${slideshowPath}" -i "${bgmTrimmedPath}" -vf "subtitles='${escapedAssPath}':fontsdir='${fontsDir}'" -c:v libx264 -preset fast -pix_fmt yuv420p -c:a aac -b:a 192k -shortest "${outputPath}"`;
    await (this.ffmpegService as any).ztteam_runFfmpeg(mergeCmd, 45000);

    /** 6. Generate Thumbnail */
    const thumbnailPath = path.join(workDir, 'thumbnail.jpg');
    await this.ffmpegService.ztteam_generateThumbnail(outputPath, thumbnailPath);

    const videoUrl = `/storage/story-test/${jobId}/output.mp4`;
    const thumbnailUrl = `/storage/story-test/${jobId}/thumbnail.jpg`;

    this.logger.log(`Story Teaser render complete: ${videoUrl}`);
    return { videoUrl, thumbnailUrl, duration: validDuration };
  }

  /**
   * Render butter-smooth Cinematic Motion Reel from a single 2K image
   * Uses floating-point sub-pixel bicubic scaling with eval=frame to eliminate micro-jitter completely.
   * Auto-generates teaser script if missing, adds BGM fade-out, ASS subtitles and bottom CTA.
   */
  async ztteam_renderMotionReel(params: {
    imageUrl: string;
    duration?: number;
    motionStyle?: 'ambient_zoom' | 'cinematic_zoom';
    bgmTrack?: string;
    content?: string;
    scriptData?: ZTTeamStoryTeaserScriptResult;
  }): Promise<{ videoUrl: string; thumbnailUrl: string; duration: number; scriptData?: ZTTeamStoryTeaserScriptResult }> {
    const {
      imageUrl,
      duration = 15,
      motionStyle = 'ambient_zoom',
      bgmTrack = 'suspense_dramatic.mp3',
      content = '',
      scriptData,
    } = params;

    const validDuration = [10, 15, 20, 30].includes(duration) ? duration : 15;
    const jobId = `motion_reel_${Date.now()}`;
    const storageRoot = ztteam_getStorageRoot();
    const workDir = path.join(storageRoot, 'story-test', jobId);
    fs.mkdirSync(workDir, { recursive: true });

    this.logger.log(`Starting Butter-Smooth Motion Reel render: jobId=${jobId}, duration=${validDuration}s, style=${motionStyle}`);

    /** 1. Prepare Source Image */
    const localImgPath = path.join(workDir, 'source.png');
    if (imageUrl.startsWith('/storage/')) {
      const relPath = imageUrl.replace(/^\/storage\//, '');
      const fullPath = path.join(storageRoot, relPath);
      if (fs.existsSync(fullPath)) {
        fs.copyFileSync(fullPath, localImgPath);
      } else {
        await this.ztteam_downloadOrCopyImage(imageUrl, localImgPath);
      }
    } else {
      await this.ztteam_downloadOrCopyImage(imageUrl, localImgPath);
    }

    /** 2. Ensure Teaser Script Data exists for ASS Subtitles */
    let finalScriptData = scriptData;
    if (!finalScriptData || !finalScriptData.segments_en || finalScriptData.segments_en.length === 0) {
      if (content && content.trim().length > 0) {
        try {
          finalScriptData = await this.ztteam_generateScript(content, validDuration, 'suspense');
        } catch (e: any) {
          this.logger.warn(`Auto-generating script failed, using fallback: ${e.message}`);
        }
      }
    }

    if (!finalScriptData || !finalScriptData.segments_en || finalScriptData.segments_en.length === 0) {
      /** Fallback dynamic 3-beat script */
      const s1 = Math.floor(validDuration * 0.33);
      const s2 = Math.floor(validDuration * 0.66);
      finalScriptData = {
        hook_en: "You won't believe what happened next...",
        caption_en: "Full story in the comments below!",
        segments_en: [
          { start: 0, end: s1, text: "You won't believe what happened next..." },
          { start: s1, end: s2, text: "The entire room fell completely silent." },
          { start: s2, end: validDuration, text: "And the truth was finally revealed..." },
        ],
        preview_vi: {
          tieu_de: "Câu chuyện kịch tính",
          tom_tat: "Bạn sẽ không tin điều gì xảy ra tiếp theo...",
          segments_dich: [
            { start: 0, end: s1, text: "Bạn sẽ không tin điều gì xảy ra tiếp theo..." },
            { start: s1, end: s2, text: "Cả căn phòng bỗng chốc im bặt." },
            { start: s2, end: validDuration, text: "Và sự thật cuối cùng cũng được phơi bày..." },
          ],
        },
      };
    }

    /** 3. Pre-generate static blurred 9:16 background once (fast ~0.2s) */
    const bgPath = path.join(workDir, 'static_bg.jpg');
    const bgCmd = `ffmpeg -y -i "${localImgPath}" -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=25:10" -frames:v 1 "${bgPath}"`;
    await (this.ffmpegService as any).ztteam_runFfmpeg(bgCmd, 20000);

    /** 4. Pre-scale foreground base once to 1200x1200 */
    const fgBasePath = path.join(workDir, 'static_fg.jpg');
    const fgCmd = `ffmpeg -y -i "${localImgPath}" -vf "scale=1200:1200:force_original_aspect_ratio=decrease" -frames:v 1 "${fgBasePath}"`;
    await (this.ffmpegService as any).ztteam_runFfmpeg(fgCmd, 20000);

    /** 5. Prepare BGM Audio with Fade-Out */
    const bgmFileName = bgmTrack || 'suspense_dramatic.mp3';
    const bgmSourcePath = path.join(process.cwd(), 'apps', 'api', 'assets', 'bgm', bgmFileName);
    const bgmTrimmedPath = path.join(workDir, 'bgm.mp3');

    if (fs.existsSync(bgmSourcePath)) {
      const fadeStart = Math.max(1, validDuration - 1.5);
      const cutCmd = `ffmpeg -y -i "${bgmSourcePath}" -t ${validDuration} -af "afade=t=out:st=${fadeStart}:d=1.5,volume=0.85" -c:a libmp3lame -b:a 192k "${bgmTrimmedPath}"`;
      await (this.ffmpegService as any).ztteam_runFfmpeg(cutCmd, 15000);
    } else {
      const silentCmd = `ffmpeg -y -f lavfi -i "sine=frequency=110:duration=${validDuration}" -af "volume=0.2" -c:a libmp3lame "${bgmTrimmedPath}"`;
      await (this.ffmpegService as any).ztteam_runFfmpeg(silentCmd, 15000);
    }

    /** 6. Generate ASS Subtitle File for English Story Text */
    const subtitlePath = path.join(workDir, 'subtitles.ass');
    const assContent = this.ztteam_buildAssSubtitles(finalScriptData.segments_en, validDuration);
    fs.writeFileSync(subtitlePath, assContent, 'utf-8');

    /** 7. Fast 1-Pass Merge: Smooth Zoom + Overlay + ASS Subtitles + BGM */
    const outputPath = path.join(workDir, 'output.mp4');
    const escapedAssPath = subtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:');
    const fontsDir = path.join(process.cwd(), 'apps', 'api', 'assets').replace(/\\/g, '/').replace(/:/g, '\\:');
    const zoomFactor = motionStyle === 'cinematic_zoom' ? 0.18 : 0.12;

    const mergeCmd = `ffmpeg -y -loop 1 -t ${validDuration} -i "${bgPath}" -loop 1 -t ${validDuration} -i "${fgBasePath}" -i "${bgmTrimmedPath}" -filter_complex "[1:v]scale='1080*(1+${zoomFactor}*t/${validDuration})':-1:eval=frame:flags=bicubic[fg];[0:v][fg]overlay=(W-w)/2:(H-h)/2,subtitles='${escapedAssPath}':fontsdir='${fontsDir}'[vout]" -map "[vout]" -map "2:a" -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -b:a 192k -shortest "${outputPath}"`;
    await (this.ffmpegService as any).ztteam_runFfmpeg(mergeCmd, 60000);

    /** 8. Generate Thumbnail */
    const thumbnailPath = path.join(workDir, 'thumbnail.jpg');
    await this.ffmpegService.ztteam_generateThumbnail(outputPath, thumbnailPath);

    const videoUrl = `/storage/story-test/${jobId}/output.mp4`;
    const thumbnailUrl = `/storage/story-test/${jobId}/thumbnail.jpg`;

    this.logger.log(`Butter-Smooth Motion Reel complete: ${videoUrl}`);
    return {
      videoUrl,
      thumbnailUrl,
      duration: validDuration,
      scriptData: finalScriptData,
    };
  }

  /**
   * Helper: Build ASS Subtitles with large high-contrast centered text & bottom CTA
   */
  private ztteam_buildAssSubtitles(segments: ZTTeamStorySegment[], duration: number): string {
    const formatTime = (seconds: number): string => {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      const cs = Math.round((seconds % 1) * 100);
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
    };

    let events = '';
    for (const seg of segments) {
      const startT = formatTime(Math.max(0, seg.start));
      const endT = formatTime(Math.min(duration, seg.end));
      /** Format text with word wrap */
      const safeText = (seg.text || '').replace(/\n/g, ' \\N ');
      events += `Dialogue: 0,${startT},${endT},StoryText,,0,0,0,,${safeText}\n`;
    }

    /** Add persistent/late CTA banner at bottom of video */
    const ctaStart = formatTime(Math.max(0, duration - 6));
    const ctaEnd = formatTime(duration);
    events += `Dialogue: 0,${ctaStart},${ctaEnd},BottomCTA,,0,0,0,,{\\c&H00FFFF&\\b1}👉 FULL STORY LINK IN COMMENTS BELOW!{\\r}\n`;

    return `[Script Info]
Title: ZTTeam Story Teaser Subtitles
ScriptType: v4.00+
WrapStyle: 1
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: StoryText,Montserrat Black,68,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,3,5,60,60,0,1
Style: BottomCTA,Montserrat Black,46,&H0000FFFF,&H00FFFFFF,&H00000000,&HB0000000,-1,0,0,0,100,100,0,0,1,3,2,2,40,40,90,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}
`;
  }

  /**
   * Helper: Download remote image or copy local file
   */
  private async ztteam_downloadOrCopyImage(src: string, dest: string): Promise<void> {
    if (src.startsWith('http://') || src.startsWith('https://')) {
      const response = await fetch(src);
      if (!response.ok) throw new Error(`Không thể tải ảnh: ${src}`);
      const arrayBuffer = await response.arrayBuffer();
      fs.writeFileSync(dest, Buffer.from(arrayBuffer));
    } else if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    } else {
      throw new Error(`File ảnh không tồn tại: ${src}`);
    }
  }

  /**
   * Generate a standalone single story teaser image prompt & Facebook caption
   */
  async ztteam_generateStoryImagePrompt(
    content: string,
    style: string = 'cinematic',
    aspectRatio: '4:5' | '1:1' | '16:9' = '4:5',
  ): Promise<ZTTeamStorySingleImagePromptResult> {
    this.logger.log(`Extracting Single Story Image Prompt (style: ${style}, aspectRatio: ${aspectRatio})`);
    const settings = await (this.aiService as any).getSettings();
    const geminiKey = settings.geminiKey || process.env.GEMINI_API_KEY;
    const openaiKey = settings.openaiKey || process.env.OPENAI_API_KEY;
    const deepseekKey = settings.deepseekKey || process.env.DEEPSEEK_API_KEY;

    let styleKeywords = 'modern contemporary 2026 setting, realistic everyday life, contextual lighting faithful to story time (bright natural daylight if daytime scene, or warm ambient indoor lamps, chandelier, and streetlights if nighttime or evening scene), modern interior and fashionable modern clothing, sharp 8k photorealistic DSLR photograph, authentic candid shot, vivid realistic colors, high detail, lifelike facial expressions';
    if (style === 'mystery_horror') {
      styleKeywords = 'modern contemporary setting, intense atmospheric suspense, cool modern blue and natural ambient tones, sharp realistic lighting, hyper-detailed 8k photorealistic';
    } else if (style === 'vintage_antique') {
      styleKeywords = 'contemporary interior with antique heritage artifacts, modern natural lighting, sharp photorealistic DSLR photo, 8k resolution';
    }

    const systemPrompt = `You are a creative director and visual artist specializing in viral Facebook story teasers.
Your job is to read the user's story and extract the SINGLE MOST CAPTIVATING, SUSPENSEFUL visual scene that will stop scrollers on Facebook.

CRITICAL REQUIREMENTS:
1. FAITHFUL TO THE STORY'S SITUATION: Carefully read the story and depict the EXACT situation, context, location, and characters as described in the story (e.g. ranch estate, wedding dinner table, family living room, office meeting, reading of a father's will/document, graduation ceremony). Do NOT force unrelated luxury tropes; stay 100% faithful to the story's actual plot and environment.
2. MODERN REALISM (PRESENT-DAY 2026): Present the story's true situation in a clean, contemporary realistic style. Characters wear authentic modern everyday clothing suited to their role and situation. Avoid vintage, antique, sepia, or weathered retro aesthetics.
3. CONTEXTUAL & ACCURATE LIGHTING (DAY vs NIGHT): Faithfully match the time of day and setting of the scene from the story:
   - If the scene takes place during the day: Use bright natural daylight, sunny exterior, or clean, well-lit interior.
   - If the scene takes place at night, late evening, or in a dim room: Use warm ambient indoor lighting (table lamps, ceiling spotlights, bedside lamp, candles) or nighttime streetlights / car headlights. Keep the scene clearly visible and sharply focused.
   - NEVER create underexposed, muddy, blacked-out messes, and NEVER use vintage yellow/sepia tints or heavy film grain. The photo must always look like a crisp, high-end professional 2026 DSLR capture.
4. MANDATORY SAFETY & COMPLIANCE RULES:
   - NEVER depict bodily injuries, blood, medical emergency, hospital ICU beds, needles, surgery, patient gowns, or medical treatment.
   - If the story is set in a hospital or clinic, depict ONLY a healthy adult in a bright, modern reception lobby or hallway holding a paper document or smartphone, strictly PG-safe.
   - NEVER depict children, minors, or teens in distress, danger, or medical emergency.
   - ALWAYS represent dramatic tension through ADULT psychological confrontations, intense facial expressions of shock, disbelief, or realization, holding crucial story objects (such as signed papers, wills, deeds, letters, keys, or phones).
5. Write a bilingual review object:
   - scene_desc_vi: Explain in Vietnamese what this visual scene represents in the story so the admin understands why this scene was picked.
   - image_prompt_en: The English prompt (60 to 100 words) ready for image generation, describing the characters, their emotion, the exact setting from the story, natural lighting, and modern photorealistic quality.
   - caption_en: A punchy Facebook post caption in English ending with a cliffhanger directing readers to the pinned first comment.
   - first_comment: The first pinned comment with a call to action and story link mockup.

OUTPUT FORMAT:
Return ONLY valid JSON matching this schema:
{
  "scene_desc_vi": "Mô tả bối cảnh đắt giá nhất của câu chuyện bằng tiếng Việt",
  "image_prompt_en": "Ultra-detailed English image generation prompt with cinematic lighting, depth of field, hyper-realistic details",
  "caption_en": "Facebook caption with emojis and hook...",
  "first_comment": "👉 Read the full shocking story here: https://yourwebsite.com/story-link (Pinned)"
}`;


    const userContent = `Read this story and create the single image teaser concept:\n\n${content.substring(0, 25000)}`;

    let rawJsonText = '';
    try {
      if (geminiKey) {
        this.logger.log('Using Gemini 3.5 Flash Lite for Single Image Prompt');
        const genAI = new GoogleGenerativeAI(geminiKey);
        const model = genAI.getGenerativeModel({
          model: 'gemini-3.5-flash-lite',
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.75,
            maxOutputTokens: 2000,
          },
        });
        const result = await model.generateContent(`${systemPrompt}\n\n${userContent}`);
        rawJsonText = result.response.text();
      } else if (openaiKey) {
        this.logger.log('Using OpenAI gpt-4o-mini for Single Image Prompt');
        const openai = new OpenAI({ apiKey: openaiKey });
        const res = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.75,
        });
        rawJsonText = res.choices[0]?.message?.content || '{}';
      } else if (deepseekKey) {
        this.logger.log('Using DeepSeek for Single Image Prompt');
        const openai = new OpenAI({ apiKey: deepseekKey, baseURL: 'https://api.deepseek.com' });
        const res = await openai.chat.completions.create({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.75,
        });
        rawJsonText = res.choices[0]?.message?.content || '{}';
      } else {
        return this.ztteam_getMockSingleImagePrompt(content, aspectRatio);
      }

      const parsed = JSON.parse(rawJsonText);
      return {
        scene_desc_vi: parsed.scene_desc_vi || 'Khoảnh khắc bí ẩn cao trào của câu chuyện.',
        image_prompt_en: parsed.image_prompt_en || `Cinematic shot, mysterious atmosphere, ${styleKeywords}`,
        caption_en: parsed.caption_en || 'Some secrets should never be uncovered... Read the full story in the comments below! #mystery #truestory',
        first_comment: parsed.first_comment || '👉 Read the full shocking story here: https://yourwebsite.com/story-link (Pinned)',
        aspect_ratio: aspectRatio,
      };
    } catch (e: any) {
      this.logger.error(`Error generating single image prompt: ${e.message}`);
      const mock = this.ztteam_getMockSingleImagePrompt(content, aspectRatio);
      mock.scene_desc_vi = `[Lưu ý: API AI gặp lỗi (${e.message}) - Đã tạo prompt mẫu để bạn thử nghiệm]`;
      return mock;
    }
  }

  /**
   * Fetch and extract article content from source URL
   */
  async ztteam_fetchSourceUrl(url: string) {
    this.logger.log(`Fetching story source from URL: ${url}`);
    return this.fetcherService.ztteam_fetchUrlData(url);
  }

  /**
   * ZTTeam: Render single image (SangTao.ai đã được gỡ bỏ khỏi hệ thống)
   */
  async ztteam_renderStoryImage(params: {
    prompt: string;
    aspectRatio?: '4:5' | '1:1' | '16:9';
    seed?: number;
    isFallback?: boolean;
    apiKey?: string;
  }): Promise<ZTTeamStorySingleImageResult> {
    throw new HttpException('Dịch vụ tạo ảnh SangTao.ai đã được gỡ bỏ. Hệ thống chuyển sang sử dụng trực tiếp ảnh chuẩn nguồn.', HttpStatus.BAD_REQUEST);
  }



  /**
   * Fallback mock single image prompt
   */
  private ztteam_getMockSingleImagePrompt(
    content: string,
    aspectRatio: '4:5' | '1:1' | '16:9' = '4:5',
  ): ZTTeamStorySingleImagePromptResult {
    return {
      scene_desc_vi: 'Cặp đôi phát hiện một chiếc hộp sắt cổ năm 1920 bị khóa chặt dưới sàn gỗ của ngôi nhà mới chuyển đến, trên nắp hộp có khắc dòng chữ cảnh báo rùng rợn.',
      image_prompt_en: 'Cinematic hyper-realistic 8k shot of an eerie antique 1920 rusted metal lockbox uncovered beneath dusty dark wooden floorboards, dim dramatic volumetric lighting cutting through the room, mysterious cryptic warning carved on the lid, dark suspense thriller atmosphere, intense moody shadows, sharp focus, 8k masterpiece',
      caption_en: 'They thought they bought a peaceful 100-year-old house... until they pulled up the floorboards in the master bedroom. 😱 What was inside that rusted 1920 lockbox? Read the full chilling story in the pinned comment below! 👇 #truestory #mystery #horror #unsolved',
      first_comment: '👉 Read the shocking full story here: https://yourwebsite.com/the-1920-box (Pinned)',
      aspect_ratio: aspectRatio,
    };
  }

}
