/* eslint-disable @typescript-eslint/no-base-to-string */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unused-vars */

/* eslint-disable @typescript-eslint/restrict-template-expressions */

import { Injectable, OnModuleInit } from '@nestjs/common';
import { Telegraf, Scenes, session } from 'telegraf';
import axios from 'axios';
import { toJalaali } from 'jalaali-js';
import { StorageService } from '../storage/storage.service';

interface BillEntry {
  alias: string;
  billId: string;
}

interface UserState {
  mainMessageId?: number;
  reportCount?: number;
  lastReportDate?: string;
  pdfData?: any[];
  sentMessageIds: number[];
}

@Injectable()
export class TelegramService implements OnModuleInit {
  private bot: Telegraf<Scenes.WizardContext>;
  private userStates: Map<number, UserState> = new Map();
  private readonly DAILY_REPORT_LIMIT = 20;

  constructor(private readonly storageService: StorageService) {
    this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
    this.setupMiddlewares();
    this.setupCommands();
    this.setupCallbacks();
  }

  async onModuleInit() {
    try {
      await this.bot.launch();
    } catch (err) {
      console.error('Failed to launch bot:', err);
    }
  }

  private setupMiddlewares() {
    this.bot.use(session());

    this.bot.catch((err) => {
      console.error('Bot global error:', err);
    });
  }

  private getUserState(userId: number): UserState {
    if (!this.userStates.has(userId)) {
      this.userStates.set(userId, {
        reportCount: 0,
        lastReportDate: this.getCurrentDate(),
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
    try {
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
            text: entries[i].alias,
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
      ]);

      keyboard.push([{ text: '❓ راهنما', callback_data: 'help' }]);

      return keyboard;
    } catch (err) {
      console.error('createMainKeyboard error:', err);
      return [[{ text: '🏠 منوی اصلی', callback_data: 'back_to_main' }]];
    }
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

  private async flashMessage(ctx: any, text: string, delayMs = 1500) {
    const userId = ctx.from.id;
    const userState = this.getUserState(userId);

    if (userState.mainMessageId) {
      try {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          userState.mainMessageId,
          undefined,
          text,
          { parse_mode: 'Markdown' },
        );
      } catch {
        // If edit fails, returnToMainMenu will re-send
      }
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await this.returnToMainMenu(ctx);
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

  private setupCommands() {
    this.bot.command('start', async (ctx) => {
      try {
        const userId = ctx.from.id;

        await this.updateMainMenu(
          ctx,
          userId,
          `🔌 *به ربات اطلاع رسانی برنامه قطعی برق کرمانشاه خوش آمدید!*

با این ربات می‌تونید:
⚡ زمان‌های قطعی برق رو بر اساس شناسه قبض بررسی کنید
🏠 چندین قبض رو ذخیره و مدیریت کنید
📊 گزارش‌ سریع از برنامه قطعی برق امروز روی تمام قبوض خود دریافت کنید

برای ادامه از دکمه‌های زیر استفاده کنید:`,
        );
      } catch (err) {
        console.error('start command error:', err);
      }
    });

    this.bot.command('menu', async (ctx) => {
      try {
        await this.returnToMainMenu(ctx);
      } catch (err) {
        console.error('menu command error:', err);
      }
    });
  }

  private setupCallbacks() {
    // Back to main menu
    this.bot.action('back_to_main', async (ctx) => {
      try {
        ctx.answerCbQuery().catch(() => {});
        await this.returnToMainMenu(ctx);
      } catch (err) {
        console.error('back_to_main error:', err);
      }
    });

    // Help callback
    this.bot.action('help', async (ctx) => {
      try {
        ctx.answerCbQuery().catch(() => {});
        const userId = ctx.from.id;
        const helpText = `❓ *راهنمای ربات*

⚡ *بررسی سریع قطعی:* زمان قطعی برق تمام قبوض ذخیره شده را بررسی کنید
🏠 *انتخاب قبض:* یک قبض ذخیره شده را انتخاب کنید
➕ *افزودن قبض:* شناسه قبض جدیدی اضافه کنید
🗑 *حذف قبض:* قبض ذخیره شده را حذف کنید
📊 *گزارش امروز همه:* گزارش کامل قطعی امروز تمام قبوض

📌 *نکته:* شناسه قبض را از قبض برق خود پیدا کنید.`;

        await this.updateMainMenu(ctx, userId, helpText);
      } catch (err) {
        console.error('help error:', err);
      }
    });

    // Quick check all bills
    this.bot.action('quick_check', async (ctx) => {
      try {
        ctx.answerCbQuery().catch(() => {});
        const userId = ctx.from.id;
        const { allowed, message: limitMsg } =
          this.canUserRequestReport(userId);

        if (!allowed) {
          await this.flashMessage(ctx, limitMsg);
          return;
        }

        const entries = await this.storageService.getEntries(userId);

        if (entries.length === 0) {
          await this.flashMessage(
            ctx,
            '❌ شما هنوز قبضی ذخیره نکرده‌اید. ابتدا یک قبض اضافه کنید.',
          );
          return;
        }

        const today = this.getDateForType('today');
        let message = `⚡ *بررسی سریع قطعی برق - ${today}*\n\n`;

        for (const entry of entries) {
          try {
            const outages = await this.fetchOutageData(entry.billId);
            if (outages.length > 0) {
              message += `*${entry.alias}:*\n`;
              outages.forEach((time) => {
                message += `  🔴 ${time}\n`;
              });
            } else {
              message += `*${entry.alias}:* ✅ بدون قطعی\n`;
            }
          } catch {
            message += `*${entry.alias}:* ❌ خطا در دریافت اطلاعات\n`;
          }
        }

        await this.updateMainMenu(ctx, userId, message);
      } catch (err) {
        console.error('quick_check error:', err);
      }
    });

    // Add bill callback
    this.bot.action('add_bill', async (ctx) => {
      try {
        ctx.answerCbQuery().catch(() => {});
        const userId = ctx.from.id;

        await this.updateMainMenu(
          ctx,
          userId,
          '➕ *افزودن قبض جدید*\n\nلطفاً شناسه قبض خود را وارد کنید:\n(شناسه قبض را از روی قبض برق پیدا کنید)',
          [[{ text: '🔙 بازگشت', callback_data: 'back_to_main' }]],
        );

        this.getUserState(userId).pdfData = [{ expectingBillId: true }];
      } catch (err) {
        console.error('add_bill error:', err);
      }
    });

    // Manage bills callback
    this.bot.action('manage_bills', async (ctx) => {
      try {
        ctx.answerCbQuery().catch(() => {});
        const userId = ctx.from.id;
        const entries = await this.storageService.getEntries(userId);

        if (entries.length === 0) {
          await this.flashMessage(ctx, '❌ شما هنوز قبضی ذخیره نکرده‌اید.');
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
      } catch (err) {
        console.error('manage_bills error:', err);
      }
    });

    // Full report for today
    this.bot.action('full_report', async (ctx) => {
      try {
        ctx.answerCbQuery().catch(() => {});
        const userId = ctx.from.id;
        const { allowed, message: limitMsg } =
          this.canUserRequestReport(userId);

        if (!allowed) {
          await this.flashMessage(ctx, limitMsg);
          return;
        }

        const entries = await this.storageService.getEntries(userId);

        if (entries.length === 0) {
          await this.flashMessage(ctx, '❌ شما هنوز قبضی ذخیره نکرده‌اید.');
          return;
        }

        const today = this.getDateForType('today');
        let message = `📊 *گزارش کامل قطعی برق امروز ${today}*\n\n`;

        for (const entry of entries) {
          try {
            const outages = await this.fetchOutageData(entry.billId);
            if (outages.length > 0) {
              message += `*${entry.alias} (${entry.billId}):*\n`;
              outages.forEach((time) => {
                message += `  🔴 ${time}\n`;
              });
              message += '\n';
            } else {
              message += `*${entry.alias} (${entry.billId}):* ✅ بدون قطعی\n\n`;
            }
          } catch {
            message += `*${entry.alias} (${entry.billId}):* ❌ خطا\n\n`;
          }
        }

        await this.updateMainMenu(ctx, userId, message);
      } catch (err) {
        console.error('full_report error:', err);
      }
    });

    // Delete bill (must be before bill_(\d+) to avoid regex collision)
    this.bot.action(/delete_bill_(\d+)/, async (ctx) => {
      try {
        ctx.answerCbQuery().catch(() => {});
        const userId = ctx.from.id;
        const index = parseInt(ctx.match[1]);

        const success = await this.storageService.deleteEntry(userId, index);

        if (success) {
          await this.flashMessage(ctx, '✅ قبض با موفقیت حذف شد.');
        } else {
          await this.flashMessage(ctx, '❌ خطا در حذف قبض.');
        }
      } catch (err) {
        console.error('delete_bill error:', err);
      }
    });

    // Handle bill selection
    this.bot.action(/bill_(\d+)/, async (ctx) => {
      try {
        ctx.answerCbQuery().catch(() => {});
        const userId = ctx.from.id;
        const index = parseInt(ctx.match[1]);
        const entries = await this.storageService.getEntries(userId);
        const entry = entries[index];

        if (!entry) {
          await this.flashMessage(ctx, '❌ قبض یافت نشد.');
          return;
        }

        const today = this.getDateForType('today');
        const tomorrow = this.getDateForType('tomorrow');
        const dayAfter = this.getDateForType('dayafter');

        let message = `*${entry.alias}*\n`;
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
      } catch (err) {
        console.error('bill error:', err);
      }
    });

    // Handle text messages
    this.bot.on('text', async (ctx) => {
      try {
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
          userState.pdfData = [];

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
          userState.pdfData = [];

          await this.storageService.saveEntry(userId, { alias, billId });

          await this.flashMessage(
            ctx,
            `✅ قبض "${alias}" با شناسه ${billId} با موفقیت ذخیره شد.`,
          );
          return;
        }
      } catch (err) {
        console.error('text handler error:', err);
      }
    });
  }

  private async fetchOutageData(billId: string, date?: string) {
    const params: Record<string, string> = { id: billId };
    if (date) params.date = date;
    const response = await axios.get('http://185.226.118.253/home/popfeeder', {
      params,
      timeout: 15000,
    });
    const items = Array.isArray(response.data.data) ? response.data.data : [];
    const periods = items
      .map((item: any) => item.period)
      .filter((p: string) => /\d{2}:\d{2}-\d{2}:\d{2}/.test(p));
    return [...new Set(periods)];
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
