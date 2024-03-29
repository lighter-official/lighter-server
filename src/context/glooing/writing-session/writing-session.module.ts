import { Module } from '@nestjs/common';
import { WritingSessionService } from './writing-session.service';
import { WritingSessionController } from './writing-session.controller';

@Module({
  controllers: [WritingSessionController],
  providers: [WritingSessionService],
  exports: [WritingSessionService],
})
export class WritingSessionModule {}
