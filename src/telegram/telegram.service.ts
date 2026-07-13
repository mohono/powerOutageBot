/* eslint-disable @typescript-eslint/no-base-to-string */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/restrict-template-expressions */
/* eslint-disable @typescript-eslint/require-await */
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Telegraf, Scenes, session, Markup } from 'telegraf';
import axios from 'axios';
import { toJalaali } from 'jalaali-js';
import { StorageService } from '../storage/storage.service';
import * as fs from 'fs';

interface BillEntry {
  alias: string;
  billId: string;
}

interface UserState {
  mainMessageId?: number;
  reportCount?: number;
  lastReportDate?: string;
  pdfData?: any[];
  selectedAreas?: string[];
  sentMessageIds: number[];
}

interface OutageArea {
  id: number;
  name: string;
  times: string[];
  subAreas?: string[];
}

@Injectable()
export class TelegramService implements OnModuleInit {
  private bot: Telegraf<Scenes.WizardContext>;
  private userStates: Map<number, UserState> = new Map();
  private readonly DAILY_REPORT_LIMIT = 20;
  private outageAreas: OutageArea[] = [];

  constructor(private readonly storageService: StorageService) {
    this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
    this.setupMiddlewares();
    this.setupWizard();
    this.setupCommands();
    this.setupCallbacks();
    this.parsePdfStructure();
  }

  async onModuleInit() {
    await this.bot.launch();
  }

  private setupMiddlewares() {
    this.bot.use(session());
  }

  private getUserState(userId: number): UserState {
    if (!this.userStates.has(userId)) {
      this.userStates.set(userId, {
        reportCount: 0,
        lastReportDate: this.getCurrentDate(),
        selectedAreas: [],
        sentMessageIds: [],
      });
    }

    const userState = this.userStates.get(userId);
    // Reset report count if it's a new day
    if (userState.lastReportDate !== this.getCurrentDate()) {
      userState.reportCount = 0;
      userState.lastReportDate = this.getCurrentDate();
    }

    return userState;
  }

  private getCurrentDate(): string {
    const now = new Date();
    return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  }

  private canUserRequestReport(userId: number): {
    allowed: boolean;
    message?: string;
  } {
    const userState = this.getUserState(userId);

    if (userState.reportCount >= this.DAILY_REPORT_LIMIT) {
      return {
        allowed: false,
        message: `❌ *محدودیت درخواست*\n\nشما امروز بیش از ${this.DAILY_REPORT_LIMIT} گزارش دریافت کرده‌اید.\nلطفاً فردا مجدداً تلاش کنید.`,
      };
    }

    userState.reportCount++;
    return { allowed: true };
  }

  private async createMainKeyboard(userId: number) {
    const entries = await this.storageService.getEntries(userId);

    const keyboard = [];

    // Quick access buttons for saved bills
    if (entries.length > 0) {
      keyboard.push([
        { text: '⚡ بررسی سریع قطعی', callback_data: 'quick_check' },
      ]);

      // Add bill buttons (max 2 per row)
      const billButtons = [];
      for (let i = 0; i < entries.length; i++) {
        billButtons.push({
          text: `🏠 ${entries[i].alias}`,
          callback_data: `bill_${i}`,
        });

        if (billButtons.length === 2 || i === entries.length - 1) {
          keyboard.push([...billButtons]);
          billButtons.length = 0;
        }
      }
    }

    // Action buttons
    keyboard.push([
      { text: '➕ افزودن قبض', callback_data: 'add_bill' },
      { text: '🗑 حذف قبض', callback_data: 'manage_bills' },
    ]);

    keyboard.push([
      { text: '📊 گزارش امروز همه', callback_data: 'full_report' },
      { text: '📄 مشاهده برنامه PDF', callback_data: 'view_pdf_schedule' },
    ]);

    keyboard.push([
      { text: '❓ راهنما', callback_data: 'help' },
      { text: '🧹 پاکسازی', callback_data: 'cleanup' },
    ]);

    return keyboard;
  }

  private async updateMainMenu(
    ctx: any,
    userId: number,
    text?: string,
    keyboard?: any[],
  ) {
    const userState = this.getUserState(userId);
    const menuText =
      text ||
      '📱 *منوی اصلی*\n\nاز دکمه‌های زیر برای دسترسی سریع استفاده کنید:';
    const menuKeyboard = keyboard || (await this.createMainKeyboard(userId));

    try {
      if (userState.mainMessageId) {
        // Try to edit existing message
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          userState.mainMessageId,
          undefined,
          menuText,
          {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: menuKeyboard },
          },
        );
      } else {
        // Send new message if no main message exists
        const sentMessage = await ctx.reply(menuText, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: menuKeyboard },
        });
        userState.mainMessageId = sentMessage.message_id;
        userState.sentMessageIds.push(sentMessage.message_id);
      }
    } catch (error) {
      // If edit fails (message too old or deleted), delete old and send new
      if (userState.mainMessageId) {
        ctx.telegram
          .deleteMessage(ctx.chat.id, userState.mainMessageId)
          .catch(() => {});
      }
      try {
        const sentMessage = await ctx.reply(menuText, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: menuKeyboard },
        });
        userState.mainMessageId = sentMessage.message_id;
        userState.sentMessageIds.push(sentMessage.message_id);
      } catch (sendError) {
        console.error('Failed to update menu:', sendError);
      }
    }
  }

  private async replyTemp(ctx: any, text: string, delayMs = 2000) {
    const userId = ctx.from.id;
    const userState = this.getUserState(userId);
    const msg = await ctx.reply(text, { parse_mode: 'Markdown' });
    userState.sentMessageIds.push(msg.message_id);
    setTimeout(() => {
      ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
    }, delayMs);
  }

  private deleteUserMessage(ctx: any, delayMs = 2000) {
    setTimeout(() => {
      ctx.telegram
        .deleteMessage(ctx.chat.id, ctx.message.message_id)
        .catch(() => {});
    }, delayMs);
  }

  private async returnToMainMenu(ctx: any) {
    const userId = ctx.from.id;

    // Leave any active scene
    if (ctx.scene) {
      await ctx.scene.leave();
    }

    // Update to main menu
    await this.updateMainMenu(ctx, userId);
  }

  // Parse the PDF structure from the provided text
  private parsePdfStructure() {
    // This is a simplified parser for the specific PDF format
    // In a real implementation, you would extract text from the actual PDF file
    const pdfText = `...`; // Your PDF text content here

    const lines = pdfText.split('\n');
    let currentArea: Partial<OutageArea> = {};

    for (const line of lines) {
      // Check if line starts with a number (new area)
      const areaMatch = line.match(/^(\d+)([^\d].*)$/);
      if (areaMatch) {
        // Save previous area if exists
        if (currentArea.name) {
          this.outageAreas.push(currentArea as OutageArea);
        }

        // Start new area
        currentArea = {
          id: parseInt(areaMatch[1]),
          name: areaMatch[2].trim(),
          times: [],
          subAreas: [],
        };
      }
      // Check for time patterns (HH:MM-HH:MM)
      else if (line.match(/\d{2}:\d{2}-\d{2}:\d{2}/)) {
        const times = line.match(/\d{2}:\d{2}-\d{2}:\d{2}/g);
        if (times && currentArea.times) {
          currentArea.times.push(...times);
        }
      }
      // Check for sub-areas (lines that start with special characters)
      else if (
        line.match(/^[^a-zA-Z0-9\u0600-\u06FF]/) &&
        currentArea.subAreas
      ) {
        currentArea.subAreas.push(line.trim());
      }
    }

    // Add the last area
    if (currentArea.name) {
      this.outageAreas.push(currentArea as OutageArea);
    }
  }

  // Search areas by name
  private searchAreas(query: string): OutageArea[] {
    if (!query) return this.outageAreas;

    return this.outageAreas.filter(
      (area) =>
        area.name.includes(query) ||
        (area.subAreas && area.subAreas.some((sub) => sub.includes(query))),
    );
  }

  // Generate area selection keyboard
  private createAreaSelectionKeyboard(
    areas: OutageArea[],
    page: number = 0,
    searchQuery: string = '',
  ): any[] {
    const itemsPerPage = 5;
    const startIdx = page * itemsPerPage;
    const paginatedAreas = areas.slice(startIdx, startIdx + itemsPerPage);

    const keyboard = paginatedAreas.map((area) => [
      {
        text: `${area.id}. ${area.name}`,
        callback_data: `area_${area.id}`,
      },
    ]);

    // Add pagination controls if needed
    const pagination = [];
    if (page > 0) {
      pagination.push({
        text: '⬅️ قبلی',
        callback_data: `area_page_${page - 1}_${searchQuery}`,
      });
    }

    if (startIdx + itemsPerPage < areas.length) {
      pagination.push({
        text: '➡️ بعدی',
        callback_data: `area_page_${page + 1}_${searchQuery}`,
      });
    }

    if (pagination.length > 0) {
      keyboard.push(pagination);
    }

    // Add search button
    keyboard.push([{ text: '🔍 جستجوی مجدد', callback_data: 'area_search' }]);

    // Add back to main menu
    keyboard.push([{ text: '🏠 منوی اصلی', callback_data: 'back_to_main' }]);

    return keyboard;
  }

  private setupCommands() {
    this.bot.command('start', async (ctx) => {
      const userId = ctx.from.id;

      await this.updateMainMenu(
        ctx,
        userId,
        `🔌 *به ربات اطلاع رسانی برنامه قطعی برق کرمانشاه خوش آمدید!*

با این ربات می‌تونید:
⚡ زمان‌های قطعی برق رو بر اساس شناسه قبض بررسی کنید
🏠 چندین قبض رو ذخیره و مدیریت کنید
📊 گزارش‌ سریع از برنامه قطعی برق امروز روی تمام قبوض خود دریافت کنید
📄 برنامه قطعی برق از طریق فایل PDF رو مشاهده کنید

برای ادامه از دکمه‌های زیر استفاده کنید:`,
      );
    });

    this.bot.command('menu', async (ctx) => {
      await this.returnToMainMenu(ctx);
    });

    // Add command to view PDF schedule
    this.bot.command('pdf', async (ctx) => {
      await this.showPdfScheduleMenu(ctx);
    });
  }

  // Show PDF schedule menu
  private async showPdfScheduleMenu(ctx: any) {
    const userId = ctx.from.id;
    const userState = this.getUserState(userId);

    await this.updateMainMenu(
      ctx,
      userId,
      '📄 *برنامه قطعی برق از طریق PDF*\n\nلطفاً یک منطقه را انتخاب کنید:',
      this.createAreaSelectionKeyboard(this.outageAreas),
    );
  }

  private setupCallbacks() {
    // Back to main menu
    this.bot.action('back_to_main', async (ctx) => {
      ctx.answerCbQuery().catch(() => {});
      await this.returnToMainMenu(ctx);
    });

    // Cleanup - delete all messages and show fresh menu
    this.bot.action('cleanup', async (ctx) => {
      ctx.answerCbQuery().catch(() => {});
      const userId = ctx.from.id;
      const userState = this.getUserState(userId);

      // Delete the current menu message
      if (userState.mainMessageId) {
        ctx.telegram
          .deleteMessage(ctx.chat.id, userState.mainMessageId)
          .catch(() => {});
      }
      // Delete all other tracked messages
      for (const msgId of userState.sentMessageIds) {
        ctx.telegram.deleteMessage(ctx.chat.id, msgId).catch(() => {});
      }

      // Reset state
      userState.mainMessageId = undefined;
      userState.sentMessageIds = [];

      // Send fresh main menu
      await this.updateMainMenu(ctx, userId);
    });

    // Help callback
    this.bot.action('help', async (ctx) => {
      ctx.answerCbQuery().catch(() => {});
      const userId = ctx.from.id;
      const helpText = `❓ *راهنمای ربات*

⚡ *بررسی سریع قطعی:* زمان قطعی برق تمام قبوض ذخیره شده را بررسی کنید
🏠 *انتخاب قبض:* یک قبض ذخیره شده را انتخاب کنید
➕ *افزودن قبض:* شناسه قبض جدیدی اضافه کنید
🗑 *حذف قبض:* قبض ذخیره شده را حذف کنید
📊 *گزارش امروز همه:* گزارش کامل قطعی امروز تمام قبوض
📄 *مشاهده برنامه PDF:* برنامه قطعی برق مناطق را ببینید

📌 *نکته:* شناسه قبض را از قبض برق خود پیدا کنید.`;

      await this.updateMainMenu(ctx, userId, helpText);
    });

    // Quick check all bills
    this.bot.action('quick_check', async (ctx) => {
      ctx.answerCbQuery().catch(() => {});
      const userId = ctx.from.id;
      const entries = await this.storageService.getEntries(userId);

      if (entries.length === 0) {
        this.replyTemp(
          ctx,
          '❌ شما هنوز قبضی ذخیره نکرده‌اید. ابتدا یک قبض اضافه کنید.',
        );
        return;
      }

      const today = this.formatPersianDate('today');
      let message = `⚡ *بررسی سریع قطعی برق - ${today}*\n\n`;

      for (const entry of entries) {
        try {
          const outages = await this.fetchOutageData(entry.billId, today);
          if (outages.length > 0) {
            message += `🏠 *${entry.alias}:*\n`;
            outages.forEach((time) => {
              message += `  🔴 ${time}\n`;
            });
          } else {
            message += `🏠 *${entry.alias}:* ✅ بدون قطعی\n`;
          }
        } catch {
          message += `🏠 *${entry.alias}:* ❌ خطا در دریافت اطلاعات\n`;
        }
      }

      await this.updateMainMenu(ctx, userId, message);
    });

    // Add bill callback
    this.bot.action('add_bill', async (ctx) => {
      ctx.answerCbQuery().catch(() => {});
      const userId = ctx.from.id;

      await this.updateMainMenu(
        ctx,
        userId,
        '➕ *افزودن قبض جدید*\n\nلطفاً شناسه قبض خود را وارد کنید:\n(شناسه قبض را از روی قبض برق پیدا کنید)',
        [[{ text: '🔙 بازگشت', callback_data: 'back_to_main' }]],
      );

      this.getUserState(userId).pdfData = [{ expectingBillId: true }];
    });

    // Manage bills callback
    this.bot.action('manage_bills', async (ctx) => {
      ctx.answerCbQuery().catch(() => {});
      const userId = ctx.from.id;
      const entries = await this.storageService.getEntries(userId);

      if (entries.length === 0) {
        this.replyTemp(ctx, '❌ شما هنوز قبضی ذخیره نکرده‌اید.');
        return;
      }

      let message = '🗑 *مدیریت قبوض*\n\nقبوض ذخیره شده:\n\n';
      const keyboard = [];

      entries.forEach((entry, index) => {
        message += `${index + 1}. ${entry.alias} (${entry.billId})\n`;
        keyboard.push([
          {
            text: `🗑 حذف ${entry.alias}`,
            callback_data: `delete_bill_${index}`,
          },
        ]);
      });

      keyboard.push([{ text: '🔙 بازگشت', callback_data: 'back_to_main' }]);

      await this.updateMainMenu(ctx, userId, message, keyboard);
    });

    // Full report for today
    this.bot.action('full_report', async (ctx) => {
      ctx.answerCbQuery().catch(() => {});
      const userId = ctx.from.id;
      const { allowed, message: limitMsg } = this.canUserRequestReport(userId);

      if (!allowed) {
        this.replyTemp(ctx, limitMsg);
        return;
      }

      const entries = await this.storageService.getEntries(userId);

      if (entries.length === 0) {
        this.replyTemp(ctx, '❌ شما هنوز قبضی ذخیره نکرده‌اید.');
        return;
      }

      const today = this.formatPersianDate('today');
      let message = `📊 *گزارش کامل قطعی برق امروز ${today}*\n\n`;

      for (const entry of entries) {
        try {
          const outages = await this.fetchOutageData(entry.billId, today);
          if (outages.length > 0) {
            message += `🏠 *${entry.alias} (${entry.billId}):*\n`;
            outages.forEach((time) => {
              message += `  🔴 ${time}\n`;
            });
            message += '\n';
          } else {
            message += `🏠 *${entry.alias} (${entry.billId}):* ✅ بدون قطعی\n\n`;
          }
        } catch {
          message += `🏠 *${entry.alias} (${entry.billId}):* ❌ خطا\n\n`;
        }
      }

      await this.updateMainMenu(ctx, userId, message);
    });

    // Delete bill (must be before bill_(\d+) to avoid regex collision)
    this.bot.action(/delete_bill_(\d+)/, async (ctx) => {
      ctx.answerCbQuery().catch(() => {});
      const userId = ctx.from.id;
      const index = parseInt(ctx.match[1]);

      const success = await this.storageService.deleteEntry(userId, index);

      if (success) {
        this.replyTemp(ctx, '✅ قبض با موفقیت حذف شد.');
      } else {
        this.replyTemp(ctx, '❌ خطا در حذف قبض.');
      }

      await this.returnToMainMenu(ctx);
    });

    // Handle bill selection
    this.bot.action(/bill_(\d+)/, async (ctx) => {
      ctx.answerCbQuery().catch(() => {});
      const userId = ctx.from.id;
      const index = parseInt(ctx.match[1]);
      const entries = await this.storageService.getEntries(userId);
      const entry = entries[index];

      if (!entry) {
        this.replyTemp(ctx, '❌ قبض یافت نشد.');
        return;
      }

      const today = this.formatPersianDate('today');
      const tomorrow = this.formatPersianDate('tomorrow');
      const dayAfter = this.formatPersianDate('dayafter');

      let message = `🏠 *${entry.alias}*\n`;
      message += `📌 شناسه قبض: ${entry.billId}\n\n`;

      try {
        const todayOutages = await this.fetchOutageData(entry.billId, today);
        const tomorrowOutages = await this.fetchOutageData(
          entry.billId,
          tomorrow,
        );
        const dayAfterOutages = await this.fetchOutageData(
          entry.billId,
          dayAfter,
        );

        message += `📅 *امروز (${today}):*\n`;
        if (todayOutages.length > 0) {
          todayOutages.forEach((time) => {
            message += `  🔴 ${time}\n`;
          });
        } else {
          message += '  ✅ بدون قطعی\n';
        }

        message += `\n📅 *فردا (${tomorrow}):*\n`;
        if (tomorrowOutages.length > 0) {
          tomorrowOutages.forEach((time) => {
            message += `  🔴 ${time}\n`;
          });
        } else {
          message += '  ✅ بدون قطعی\n';
        }

        message += `\n📅 *پس فردا (${dayAfter}):*\n`;
        if (dayAfterOutages.length > 0) {
          dayAfterOutages.forEach((time) => {
            message += `  🔴 ${time}\n`;
          });
        } else {
          message += '  ✅ بدون قطعی\n';
        }
      } catch {
        message += '❌ خطا در دریافت اطلاعات قطعی برق.';
      }

      const keyboard = [
        [
          { text: '🔄 بروزرسانی', callback_data: `bill_${index}` },
          { text: '🏠 منوی اصلی', callback_data: 'back_to_main' },
        ],
      ];

      await this.updateMainMenu(ctx, userId, message, keyboard);
    });

    // PDF schedule callback
    this.bot.action('view_pdf_schedule', async (ctx) => {
      ctx.answerCbQuery().catch(() => {});
      await this.showPdfScheduleMenu(ctx);
    });

    // Area selection callback
    this.bot.action(/area_(\d+)/, async (ctx) => {
      ctx.answerCbQuery().catch(() => {});
      const areaId = parseInt(ctx.match[1]);
      const area = this.outageAreas.find((a) => a.id === areaId);

      if (!area) {
        this.replyTemp(ctx, '❌ منطقه مورد نظر یافت نشد.');
        return;
      }

      const userId = ctx.from.id;
      const userState = this.getUserState(userId);

      // Add to selected areas if not already selected
      if (!userState.selectedAreas.includes(area.name)) {
        userState.selectedAreas.push(area.name);
      }

      // Format area information
      let message = `🔌 *برنامه قطعی برق*\n\n`;
      message += `📌 *منطقه:* ${area.name}\n\n`;

      if (area.times && area.times.length > 0) {
        message += `⏰ *ساعات قطعی:*\n`;
        area.times.forEach((time) => {
          message += `🔴 ${time}\n`;
        });
      } else {
        message += `✅ در این منطقه قطعی برنامه‌ریزی شده‌ای وجود ندارد.\n`;
      }

      if (area.subAreas && area.subAreas.length > 0) {
        message += `\n🏘 *زیرمنطقه‌ها:*\n`;
        area.subAreas.forEach((subArea) => {
          message += `• ${subArea}\n`;
        });
      }

      message += `\n⚠️ *توجه:* این اطلاعات ممکن است دقیق نباشند و قطعی‌های خارج از برنامه احتمالی هستند.`;

      const keyboard = [
        [
          {
            text: '➕ افزودن به گزارش',
            callback_data: `add_to_report_${areaId}`,
          },
          { text: '📄 مشاهده مناطق دیگر', callback_data: 'view_pdf_schedule' },
        ],
        [
          { text: '📋 مشاهده گزارش من', callback_data: 'view_my_report' },
          { text: '🏠 منوی اصلی', callback_data: 'back_to_main' },
        ],
      ];

      await this.updateMainMenu(ctx, userId, message, keyboard);
    });

    // Add to report callback
    this.bot.action(/add_to_report_(\d+)/, async (ctx) => {
      ctx.answerCbQuery('✅ به گزارش شما اضافه شد').catch(() => {});
      const areaId = parseInt(ctx.match[1]);
      const area = this.outageAreas.find((a) => a.id === areaId);

      if (area) {
        const userId = ctx.from.id;
        const userState = this.getUserState(userId);

        if (!userState.selectedAreas.includes(area.name)) {
          userState.selectedAreas.push(area.name);
        }

        this.replyTemp(ctx, `✅ منطقه "${area.name}" به گزارش شما اضافه شد.`);
      }
    });

    // View my report callback
    this.bot.action('view_my_report', async (ctx) => {
      ctx.answerCbQuery().catch(() => {});
      const userId = ctx.from.id;
      const userState = this.getUserState(userId);

      if (!userState.selectedAreas || userState.selectedAreas.length === 0) {
        this.replyTemp(
          ctx,
          '📋 شما هنوز منطقه‌ای به گزارش خود اضافه نکرده‌اید.',
        );
        return;
      }

      let message = '📋 *گزارش مناطق انتخاب شده شما*\n\n';
      userState.selectedAreas.forEach((areaName, index) => {
        const area = this.outageAreas.find((a) => a.name === areaName);
        message += `${index + 1}. *${areaName}*`;

        if (area && area.times && area.times.length > 0) {
          message += ` - ⏰ ${area.times.join('، ')}`;
        }

        message += '\n';
      });

      const keyboard = [
        [
          { text: '📄 افزودن منطقه دیگر', callback_data: 'view_pdf_schedule' },
          { text: '🗑 پاک کردن گزارش', callback_data: 'clear_report' },
        ],
        [{ text: '🏠 منوی اصلی', callback_data: 'back_to_main' }],
      ];

      await this.updateMainMenu(ctx, userId, message, keyboard);
    });

    // Clear report callback
    this.bot.action('clear_report', async (ctx) => {
      ctx.answerCbQuery().catch(() => {});
      const userId = ctx.from.id;
      const userState = this.getUserState(userId);
      userState.selectedAreas = [];

      this.replyTemp(ctx, '✅ گزارش شما پاک شد.');
      await this.showPdfScheduleMenu(ctx);
    });

    // Area pagination callback
    this.bot.action(/area_page_(\d+)_?(.*)?/, async (ctx) => {
      ctx.answerCbQuery().catch(() => {});
      const page = parseInt(ctx.match[1]);
      const searchQuery = ctx.match[2] || '';

      const filteredAreas = this.searchAreas(searchQuery);
      const keyboard = this.createAreaSelectionKeyboard(
        filteredAreas,
        page,
        searchQuery,
      );

      const userId = ctx.from.id;
      await this.updateMainMenu(
        ctx,
        userId,
        `📄 *برنامه قطعی برق از طریق PDF*\n\nلطفاً یک منطقه را انتخاب کنید:`,
        keyboard,
      );
    });

    // Area search callback
    this.bot.action('area_search', async (ctx) => {
      ctx.answerCbQuery().catch(() => {});
      const userId = ctx.from.id;

      await this.updateMainMenu(
        ctx,
        userId,
        '🔍 *جستجوی منطقه*\n\nلطفاً نام منطقه مورد نظر خود را وارد کنید:',
        [[{ text: '🔙 بازگشت', callback_data: 'view_pdf_schedule' }]],
      );

      // Set state to expect search query
      this.getUserState(userId).pdfData = [{ expectingSearch: true }];
    });

    // ... existing callbacks ...

    // Handle text messages
    this.bot.on('text', async (ctx) => {
      const userId = ctx.from.id;
      const userState = this.getUserState(userId);

      // Check if we're expecting a bill ID
      if (
        userState.pdfData &&
        userState.pdfData[0] &&
        userState.pdfData[0].expectingBillId
      ) {
        this.deleteUserMessage(ctx);
        const billId = ctx.message.text.trim();
        userState.pdfData = []; // Reset state

        // Ask for alias
        userState.pdfData = [{ expectingAlias: true, newBillId: billId }];

        await this.updateMainMenu(
          ctx,
          userId,
          `✅ شناسه قبض: ${billId}\n\nلطفاً یک نام اختصاری برای این قبض وارد کنید:\n(مثال: خانه، محل کار)`,
          [[{ text: '🔙 بازگشت', callback_data: 'back_to_main' }]],
        );
        return;
      }

      // Check if we're expecting an alias
      if (
        userState.pdfData &&
        userState.pdfData[0] &&
        userState.pdfData[0].expectingAlias
      ) {
        this.deleteUserMessage(ctx);
        const alias = ctx.message.text.trim();
        const billId = userState.pdfData[0].newBillId;
        userState.pdfData = []; // Reset state

        await this.storageService.saveEntry(userId, { alias, billId });

        this.replyTemp(
          ctx,
          `✅ قبض "${alias}" با شناسه ${billId} با موفقیت ذخیره شد.`,
        );
        await this.returnToMainMenu(ctx);
        return;
      }

      // Check if we're expecting a search query
      if (
        userState.pdfData &&
        userState.pdfData[0] &&
        userState.pdfData[0].expectingSearch
      ) {
        this.deleteUserMessage(ctx);
        const searchQuery = ctx.message.text;
        userState.pdfData = []; // Reset state

        const filteredAreas = this.searchAreas(searchQuery);

        if (filteredAreas.length === 0) {
          this.replyTemp(ctx, '❌ منطقه‌ای با این نام یافت نشد.');
          await this.showPdfScheduleMenu(ctx);
          return;
        }

        const keyboard = this.createAreaSelectionKeyboard(
          filteredAreas,
          0,
          searchQuery,
        );

        await this.updateMainMenu(
          ctx,
          userId,
          `🔍 *نتایج جستجو برای "${searchQuery}"*\n\nلطفاً یک منطقه را انتخاب کنید:`,
          keyboard,
        );
      }
    });
  }

  private async fetchOutageData(billId: string, date: string) {
    const response = await axios.get(
      'http://85.185.251.108:8007/home/popfeeder',
      {
        params: { date, id: billId },
        headers: {
          accept: 'application/json, text/plain, */*',
          'accept-language': 'en-US,en;q=0.9,de;q=0.8',
          Referer: 'http://www.kpedc.com/',
          'User-Agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        },
      },
    );
    return [...new Set(response.data.data.map((item) => item.period))];
  }

  private formatPersianDate(dateType: string): string {
    const date = this.getDateForType(dateType);
    return date;
  }

  private setupWizard() {
    // ... existing wizard code ...
  }

  private getDateForType(type: string): string {
    const now = new Date();
    const date = new Date(now);
    switch (type) {
      case 'tomorrow':
        date.setDate(now.getDate() + 1);
        break;
      case 'dayafter':
        date.setDate(now.getDate() + 2);
        break;
    }
    const { jy: year, jm: month, jd: day } = toJalaali(date);
    return `${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`;
  }
}
