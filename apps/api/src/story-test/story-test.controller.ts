import { Controller, Get, Post, Body } from '@nestjs/common';
import { ZTTeamStoryTestService } from './story-test.service';

/**
 * Controller for the isolated Story Test Studio
 */
@Controller('story-test')
export class ZTTeamStoryTestController {
  constructor(private readonly storyTestService: ZTTeamStoryTestService) {}

  /**
   * Get available background music tracks
   */
  @Get('bgm-list')
  ztteam_getBgmList() {
    return this.storyTestService.ztteam_getBgmList();
  }

  /**
   * Get sample stories for one-click testing
   */
  @Get('sample-stories')
  ztteam_getSampleStories() {
    return this.storyTestService.ztteam_getSampleStories();
  }

  /**
   * Fetch and extract story content from a URL
   */
  @Post('fetch-source-url')
  async ztteam_fetchSourceUrl(@Body() body: { url: string }) {
    if (!body.url || body.url.trim().length === 0) {
      throw new Error('Vui lòng cung cấp link bài viết.');
    }
    return this.storyTestService.ztteam_fetchSourceUrl(body.url.trim());
  }

  /**
   * Generate bilingual story teaser script
   */
  @Post('generate-script')
  async ztteam_generateScript(
    @Body() body: { content: string; duration?: number; tone?: string },
  ) {
    if (!body.content || body.content.trim().length === 0) {
      throw new Error('Vui lòng cung cấp nội dung bài viết.');
    }
    const duration = Number(body.duration) || 15;
    const tone = body.tone || 'suspense';
    return this.storyTestService.ztteam_generateScript(body.content, duration, tone);
  }

  /**
   * Render isolated video preview with BGM and English ASS subtitles
   */
  @Post('render-video')
  async ztteam_renderVideo(
    @Body() body: {
      scriptData: any;
      duration?: number;
      images?: string[];
      bgmTrack?: string;
    },
  ) {
    if (!body.scriptData) {
      throw new Error('Thiếu dữ liệu kịch bản scriptData để render video.');
    }
    const duration = Number(body.duration) || 15;
    return this.storyTestService.ztteam_renderVideo({
      scriptData: body.scriptData,
      duration,
      images: body.images,
      bgmTrack: body.bgmTrack,
    });
  }

  /**
   * Extract single story image prompt & Facebook caption
   */
  @Post('generate-single-image-prompt')
  async ztteam_generateSingleImagePrompt(
    @Body() body: { content: string; style?: string; aspectRatio?: '4:5' | '1:1' | '16:9' },
  ) {
    if (!body.content || body.content.trim().length === 0) {
      throw new Error('Vui lòng cung cấp nội dung câu chuyện.');
    }
    return this.storyTestService.ztteam_generateStoryImagePrompt(
      body.content,
      body.style || 'cinematic',
      body.aspectRatio || '4:5',
    );
  }

  /**
   * Render single image from prompt using Pollinations Flux AI (0 VND)
   */
  @Post('render-single-image')
  async ztteam_renderSingleImage(
    @Body() body: { prompt: string; aspectRatio?: '4:5' | '1:1' | '16:9'; seed?: number },
  ) {
    if (!body.prompt || body.prompt.trim().length === 0) {
      throw new Error('Vui lòng nhập prompt tạo ảnh.');
    }
    return this.storyTestService.ztteam_renderStoryImage({
      prompt: body.prompt,
      aspectRatio: body.aspectRatio || '4:5',
      seed: body.seed,
    });
  }

  /**
   * Render butter-smooth Cinematic Motion Reel from a single 2K image
   */
  @Post('render-motion-reel')
  async ztteam_renderMotionReel(
    @Body()
    body: {
      imageUrl: string;
      duration?: number;
      motionStyle?: 'ambient_zoom' | 'cinematic_zoom';
      bgmTrack?: string;
      content?: string;
      scriptData?: any;
    },
  ) {
    if (!body.imageUrl || body.imageUrl.trim().length === 0) {
      throw new Error('Vui lòng cung cấp ảnh nguồn để render Video Reel.');
    }
    return this.storyTestService.ztteam_renderMotionReel({
      imageUrl: body.imageUrl,
      duration: body.duration || 15,
      motionStyle: body.motionStyle || 'ambient_zoom',
      bgmTrack: body.bgmTrack,
      content: body.content,
      scriptData: body.scriptData,
    });
  }


}

