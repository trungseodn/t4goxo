import { Module, forwardRef } from '@nestjs/common';
import { ZTTeamWordpressController } from './wordpress.controller';
import { ZTTeamWordpressService } from './wordpress.service';
import { ZTTeamHtmlCleanerService } from './html-cleaner.service';
import { PrismaModule } from '../prisma/prisma.module';
import { HttpModule } from '@nestjs/axios';
import { ZTTeamMediaModule } from '../media/media.module';

@Module({
  imports: [PrismaModule, HttpModule, forwardRef(() => ZTTeamMediaModule)],
  controllers: [ZTTeamWordpressController],
  providers: [ZTTeamWordpressService, ZTTeamHtmlCleanerService],
  exports: [ZTTeamWordpressService]
})
export class ZTTeamWordpressModule {}
