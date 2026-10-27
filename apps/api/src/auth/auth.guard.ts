import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

@Injectable()
export class ZTTeamAuthGuard implements CanActivate {
  constructor(private jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const reqPath = request.path || request.url || '';
    if (
      reqPath.includes('/branding/pending-job') || 
      (reqPath.includes('/branding/') && (reqPath.includes('/attach-result') || reqPath.includes('/reset')))
    ) {
      return true;
    }

    const token = this.ztteam_extractTokenFromHeader(request);
    
    if (!token) {
      throw new UnauthorizedException();
    }
    try {
      const payload = await this.jwtService.verifyAsync(token, {
        secret: process.env.JWT_SECRET || 'ZTREEL_SECRET_KEY_2026',
      });
      /** We're assigning the payload to the request object here */
      /** so that we can access it in our route handlers */
      request['user'] = payload;
    } catch {
      throw new UnauthorizedException();
    }
    return true;
  }

  private ztteam_extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
