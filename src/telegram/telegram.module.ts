import { Module } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { StorageService } from '../storage/storage.service';

@Module({
  providers: [TelegramService, StorageService],
  exports: [TelegramService],
})
export class TelegramModule {}
