import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import axios from 'axios';

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);

  constructor(private readonly prisma: PrismaService) {}

  async ztteam_sendMessage(message: string): Promise<boolean> {
    try {
      const tokenSetting = await this.prisma.ztteam_settings.findUnique({ where: { key: 'telegram_bot_token' } });
      const chatIdSetting = await this.prisma.ztteam_settings.findUnique({ where: { key: 'telegram_chat_id' } });

      const token = tokenSetting?.value;
      const chatId = chatIdSetting?.value;

      if (!token || !chatId) {
        /** Silently skip if not configured */
        return false;
      }

      await this.ztteam_executeSend(token, chatId, message);
      return true;
    } catch (error: any) {
      this.logger.error(`Failed to send Telegram message: ${error.message}`);
      return false;
    }
  }

  async ztteam_testMessage(token: string, chatId: string): Promise<boolean> {
    const message = `🔔 *Thông báo từ ZT-Reel System*\n\n✅ Kết nối Telegram thành công!\nHệ thống sẽ gửi các thông báo lỗi tự động vào nhóm/chat này.`;
    return this.ztteam_executeSend(token, chatId, message);
  }

  private async ztteam_executeSend(token: string, chatId: string, text: string): Promise<boolean> {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    try {
      await axios.post(url, {
        chat_id: chatId,
        text,
        parse_mode: 'Markdown'
      });
      return true;
    } catch (error: any) {
      this.logger.warn(`Telegram Markdown send failed (${error.response?.data?.description || error.message}), retrying as plain text...`);
      try {
        const cleanText = text.replace(/\*/g, '');
        await axios.post(url, {
          chat_id: chatId,
          text: cleanText
        });
        return true;
      } catch (fallbackError: any) {
        this.logger.error(`Telegram API Error: ${fallbackError.response?.data?.description || fallbackError.message}`);
        throw new Error(fallbackError.response?.data?.description || 'Lỗi kết nối đến Telegram API');
      }
    }
  }

  ztteam_formatAlert(params: {
    systemName: string;
    environment?: string;
    targetSite?: string;
    sourceUrl?: string;
    fanpageName?: string;
    postTitle?: string;
    step: string;
    rawError: string;
    nextAction?: string;
    memberEmail?: string;
  }): string {
    const {
      systemName,
      environment = process.env.NODE_ENV === 'production' ? 'VPS Production (reel.ztteam.site)' : 'Local Development',
      targetSite,
      sourceUrl,
      fanpageName,
      postTitle,
      step,
      rawError,
      nextAction = 'Hệ thống sẽ tự động thử lại ở chu kỳ tiếp theo.',
      memberEmail,
    } = params;

    const errorVi = ztteam_translateErrorVi(rawError);

    let msg = `🚨 *[LỖI HỆ THỐNG: ${systemName.toUpperCase()}]*\n\n`;
    msg += `💻 *Môi trường:* ${environment}\n`;
    if (memberEmail && memberEmail !== 'N/A') msg += `👤 *Thành viên:* ${memberEmail}\n`;
    if (targetSite) msg += `🌐 *Website Đích (WP):* ${targetSite}\n`;
    if (sourceUrl) msg += `🔗 *Link Nguồn:* ${sourceUrl}\n`;
    if (fanpageName) msg += `🚩 *Fanpage:* ${fanpageName}\n`;
    if (postTitle) msg += `📄 *Bài viết:* ${postTitle}\n`;
    msg += `📍 *Bước lỗi:* ${step}\n`;
    msg += `❌ *Nguyên nhân (Tiếng Việt):* ${errorVi}\n`;
    if (rawError && rawError !== errorVi) {
      msg += `🔍 *Mã kỹ thuật:* \`${rawError.substring(0, 150)}\`\n`;
    }
    msg += `\n🔄 *Trạng thái:* ${nextAction}`;

    return msg;
  }
}

/**
 * ZTTeam: Trích xuất thông tin lỗi chi tiết từ Axios Error, Facebook Graph API, WordPress REST API hoặc AI
 */
export function ztteam_extractErrorMessage(error: any): string {
  if (!error) return 'Lỗi không xác định';
  if (typeof error === 'string') return error;

  /** 1. Bóc tách lỗi từ Facebook Graph API */
  if (error.response?.data?.error) {
    const fb = error.response.data.error;
    const parts: string[] = [];
    if (fb.code) parts.push(`Code ${fb.code}`);
    if (fb.error_subcode) parts.push(`Subcode ${fb.error_subcode}`);
    if (fb.message) parts.push(fb.message);
    if (fb.error_user_msg) parts.push(`(${fb.error_user_msg})`);
    if (parts.length > 0) return parts.join(': ');
  }

  /** 2. Bóc tách lỗi từ WordPress REST API */
  if (error.response?.data?.message) {
    const code = error.response.data.code ? `[${error.response.data.code}] ` : '';
    return `${code}${error.response.data.message}`;
  }

  /** 3. Bóc tách lỗi từ OpenAI / SangTao AI */
  if (error.response?.data?.error?.message) {
    return error.response.data.error.message;
  }

  /** 4. Bóc tách response data dạng chuỗi */
  if (typeof error.response?.data === 'string' && error.response.data.length > 0) {
    return error.response.data.substring(0, 300);
  }

  return error.message || String(error);
}

/**
 * ZTTeam: Chuyển đổi mã lỗi hệ thống kỹ thuật sang tiếng Việt chuẩn xác, dễ hiểu
 */
export function ztteam_translateErrorVi(errorMsg: string): string {
  if (!errorMsg) return 'Lỗi không xác định.';
  const msg = errorMsg.toLowerCase();

  /** 1. Lỗi Facebook Graph API */
  if (
    msg.includes('an unknown error has occurred') ||
    msg.includes('code 1:') ||
    msg.includes('code 2:') ||
    msg.includes('status code 500') ||
    msg.includes('500 internal server error')
  ) {
    return 'Máy chủ Facebook (Graph API) gặp sự cố nội bộ tạm thời (HTTP 500 / Error Code 1). Hệ thống sẽ tự động hoãn và thử lại sau ít phút.';
  }
  /** ZTTeam: Nhận diện đặc thù Checkpoint xác minh danh tính Facebook Code 368 / Subcode 4854002 */
  if (
    msg.includes('4854002') ||
    msg.includes('xác nhận danh tính') ||
    msg.includes('confirm your identity')
  ) {
    return 'Facebook kích hoạt Checkpoint xác minh danh tính (Code 368 / Subcode 4854002). Quản trị viên cần mở ứng dụng Facebook trên điện thoại, chuyển sang Page này và bấm Xác nhận.';
  }
  if (
    msg.includes('368') ||
    msg.includes('1390008') ||
    msg.includes('going too fast') ||
    msg.includes('action blocked') ||
    msg.includes('misusing this feature') ||
    msg.includes('we limit how often') ||
    msg.includes('protect the community from spam')
  ) {
    return 'Facebook tạm khóa/giới hạn tính năng do tần suất đăng bài hoặc bình luận quá nhiều (Meta Spam Protection - Code 368 / Subcode 1390008). Vui lòng tạm hoãn để tài khoản/Page hồi phục.';
  }
  if (
    msg.includes('request limit reached') ||
    msg.includes('code 4:') ||
    msg.includes('code 17:') ||
    msg.includes('code 32:') ||
    msg.includes('code 613:')
  ) {
    return 'Vượt quá giới hạn tần suất gọi Graph API của Facebook (Rate Limit). Hệ thống sẽ tự động chờ để hồi phục hạn ngạch.';
  }
  if (
    msg.includes('error validating access token') ||
    msg.includes('session has expired') ||
    msg.includes('code 190:') ||
    msg.includes('password changed') ||
    msg.includes('user logged out')
  ) {
    return 'Token Facebook đã hết hạn hoặc tài khoản quản trị vừa đổi mật khẩu/đăng xuất. Cần kết nối lại trên Web để cấp Token mới.';
  }
  if (
    msg.includes('permissions error') ||
    msg.includes('code 200:') ||
    msg.includes('code 10:') ||
    msg.includes('pages_manage_posts') ||
    msg.includes('pages_read_engagement')
  ) {
    return 'Fanpage bị hạn chế quyền hoặc tài khoản quản trị bị mất quyền đăng bài / bình luận (Cần kiểm tra quyền pages_manage_posts).';
  }
  if (msg.includes('duplicate post') || msg.includes('code 506:')) {
    return 'Facebook từ chối do nội dung bài viết hoặc bình luận bị trùng lặp với bài vừa đăng.';
  }
  if (
    msg.includes('unsupported post request') ||
    msg.includes('subcode 33') ||
    msg.includes('object does not exist')
  ) {
    return 'Bài viết hoặc bình luận mục tiêu trên Facebook không tồn tại (có thể đã bị xóa, ẩn hoặc ID không đúng).';
  }
  if (msg.includes('checkpoint') || msg.includes('identity verification') || msg.includes('account locked')) {
    return 'Tài khoản Facebook quản trị đang bị kiểm tra danh tính (Checkpoint) hoặc bị tạm khoá. Vui lòng đăng nhập Facebook để mở checkpoint.';
  }
  if (msg.includes('invalid parameter') || msg.includes('code 100:')) {
    return 'Tham số gửi lên Facebook không hợp lệ (URL ảnh/video hoặc nội dung không đúng định dạng của Facebook).';
  }

  /** 2. Lỗi tài khoản AI SangTao / OpenAI */
  if (msg.includes('insufficient credits') || msg.includes('402') || msg.includes('balance')) {
    return 'Tài khoản SangTao.ai đã hết credit tạo ảnh (cần 4 credit để tạo ảnh 2K). Hệ thống sẽ chuyển sang dùng ảnh gốc dự phòng.';
  }
  if (msg.includes('rate limit') || msg.includes('429') || msg.includes('quota')) {
    return 'Vượt quá giới hạn tần suất gọi API AI (Rate Limit 429). Hệ thống sẽ tự động thử lại sau ít phút.';
  }
  if (msg.includes('content policy') || msg.includes('safety') || msg.includes('moderation') || msg.includes('flagged')) {
    return 'Nội dung bài viết vi phạm chính sách kiểm duyệt an toàn của AI (Content Policy). AI từ chối tạo nội dung.';
  }

  /** 3. Lỗi WordPress API */
  if (
    msg.includes('401') ||
    msg.includes('unauthorized') ||
    msg.includes('rest_forbidden') ||
    msg.includes('rest_cannot_create')
  ) {
    return 'Lỗi xác thực WordPress: Mật khẩu ứng dụng (Application Password) không đúng hoặc tài khoản không đủ quyền đăng bài.';
  }
  if (msg.includes('rest_invalid') || msg.includes('invalid_json') || msg.includes('rest_post_invalid_id')) {
    return 'Dữ liệu bài viết không hợp lệ khi gửi sang WordPress hoặc ID bài viết không tồn tại.';
  }
  if (msg.includes('rest_upload_failed') || msg.includes('upload_dir')) {
    return 'Không thể tải ảnh đại diện lên WordPress (Hết dung lượng hosting hoặc sai phân quyền thư mục uploads).';
  }

  /** 4. Lỗi mạng / Tường lửa / Cloudflare */
  if (msg.includes('403') || msg.includes('forbidden') || msg.includes('cloudflare') || msg.includes('chống bot')) {
    return 'Website nguồn chặn truy cập máy chủ (HTTP 403 Forbidden / Cloudflare chống bot cào). Hệ thống sẽ bỏ qua link này.';
  }
  if (msg.includes('timeout') || msg.includes('aborted') || msg.includes('etimedout')) {
    return 'Hết thời gian chờ kết nối (Timeout). Mạng máy chủ nguồn hoặc proxy phản hồi quá chậm.';
  }
  if (msg.includes('enotfound') || msg.includes('getaddrinfo')) {
    return 'Không thể phân giải tên miền website nguồn (Lỗi DNS hoặc tên miền không tồn tại).';
  }
  if (msg.includes('status code 502') || msg.includes('bad gateway')) {
    return 'Máy chủ trung gian phản hồi lỗi (HTTP 502 Bad Gateway). Dịch vụ đích đang khởi động lại hoặc mất kết nối.';
  }
  if (msg.includes('status code 503') || msg.includes('service unavailable')) {
    return 'Dịch vụ tạm thời không khả dụng (HTTP 503 Service Unavailable). Máy chủ đối tác đang bảo trì hoặc quá tải.';
  }
  if (msg.includes('status code 504') || msg.includes('gateway timeout')) {
    return 'Hết thời gian phản hồi từ máy chủ trung gian (HTTP 504 Gateway Timeout).';
  }
  if (msg.includes('status code 404') || msg.includes('not found')) {
    return 'Không tìm thấy tài nguyên yêu cầu (HTTP 404 Not Found). Đường dẫn URL hoặc ID không tồn tại.';
  }
  if (msg.includes('status code 400') || msg.includes('bad request')) {
    return 'Yêu cầu không hợp lệ (HTTP 400 Bad Request). Dữ liệu gửi đi bị thiếu hoặc sai định dạng.';
  }
  if (msg.includes('econnrefused')) {
    return 'Không thể kết nối đến cổng dịch vụ (Connection Refused). Dịch vụ hoặc cơ sở dữ liệu nội bộ có thể chưa khởi chạy.';
  }
  if (msg.includes('econnreset') || msg.includes('socket hang up')) {
    return 'Kết nối mạng bị ngắt đột ngột (Connection Reset / Socket Hang Up).';
  }

  /** 5. Lỗi xử lý Render Video / FFmpeg */
  if (msg.includes('out of memory') || msg.includes('killed') || msg.includes('code 137')) {
    return 'Máy chủ bị quá tải bộ nhớ RAM khi đang render video (OOM Killed). Cần kiểm tra tài nguyên VPS.';
  }
  if (msg.includes('ffmpeg') || msg.includes('spawn ffmpeg') || msg.includes('enoent')) {
    return 'Lỗi tiến trình FFmpeg khi ghép video, nạp font chữ hoặc lồng nhạc nền.';
  }
  if (msg.includes('bgm') || msg.includes('audio file not found')) {
    return 'Không tìm thấy file nhạc nền BGM được chỉ định trong thư viện.';
  }

  return errorMsg;
}
