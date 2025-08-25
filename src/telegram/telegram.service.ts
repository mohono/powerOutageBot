/* eslint-disable @typescript-eslint/no-base-to-string */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Telegraf, Scenes, session, Markup } from 'telegraf';
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
}

@Injectable()
export class TelegramService implements OnModuleInit {
  private bot: Telegraf<Scenes.WizardContext>;
  private userStates: Map<number, UserState> = new Map();
  private readonly DAILY_REPORT_LIMIT = 20;

  constructor(private readonly storageService: StorageService) {
    this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
    this.setupMiddlewares();
    this.setupWizard();
    this.setupCommands();
    this.setupCallbacks();
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
      { text: '❓ راهنما', callback_data: 'help' },
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
      }
    } catch (error) {
      // If edit fails (message too old or deleted), send new message
      try {
        const sentMessage = await ctx.reply(menuText, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: menuKeyboard },
        });
        userState.mainMessageId = sentMessage.message_id;
      } catch (sendError) {
        console.error('Failed to update menu:', sendError);
      }
    }
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
      const userId = ctx.from.id;

      // Initialize user state
      this.getUserState(userId);

      // Send main menu directly
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
    });

    this.bot.command('menu', async (ctx) => {
      await this.returnToMainMenu(ctx);
    });
  }

  private setupCallbacks() {
    // Quick check - show bills with date options
    this.bot.action('quick_check', async (ctx) => {
      await ctx.answerCbQuery();
      const userId = ctx.from.id;
      const entries = await this.storageService.getEntries(userId);

      if (!entries.length) {
        await this.updateMainMenu(
          ctx,
          userId,
          '❌ هیچ قبضی ذخیره نشده است.\nابتدا یک قبض اضافه کنید.',
        );
        return;
      }

      const keyboard = entries.map((entry, index) => [
        { text: `🏠 ${entry.alias}`, callback_data: `quick_bill_${index}` },
      ]);
      keyboard.push([{ text: '🔙 بازگشت', callback_data: 'back_to_main' }]);

      await this.updateMainMenu(
        ctx,
        userId,
        '⚡ *بررسی سریع قطعی*\n\nیک قبض انتخاب کنید:',
        keyboard,
      );
    });

    // Handle quick bill selection
    this.bot.action(/quick_bill_(\d+)/, async (ctx) => {
      await ctx.answerCbQuery();
      const billIndex = parseInt(ctx.match[1]);
      const userId = ctx.from.id;
      const entries = await this.storageService.getEntries(userId);

      if (!entries[billIndex]) return;

      const keyboard = [
        [
          { text: '🌄 پس‌فردا', callback_data: `check_${billIndex}_dayafter` },
          { text: '📅 امروز', callback_data: `check_${billIndex}_today` },
        ],
        [
          { text: '📊 هر سه روز', callback_data: `check_${billIndex}_all` },
          { text: '🌅 فردا', callback_data: `check_${billIndex}_tomorrow` },
        ],
        [{ text: '🔙 بازگشت', callback_data: 'quick_check' }],
      ];

      await this.updateMainMenu(
        ctx,
        userId,
        `🏠 *${entries[billIndex].alias}*\n📋 شناسه: \`${entries[billIndex].billId}\`\n\n📅 تاریخ مورد نظر را انتخاب کنید:`,
        keyboard,
      );
    });

    // Handle date selection for outage check
    this.bot.action(
      /check_(\d+)_(today|tomorrow|dayafter|all)/,
      async (ctx) => {
        // Check report limit
        const userId = ctx.from.id;
        const limitCheck = this.canUserRequestReport(userId);
        if (!limitCheck.allowed) {
          await ctx.answerCbQuery(limitCheck.message, { show_alert: true });
          return;
        }

        await ctx.answerCbQuery('⏳ در حال دریافت اطلاعات...');

        const billIndex = parseInt(ctx.match[1]);
        const dateType = ctx.match[2];
        const entries = await this.storageService.getEntries(userId);

        if (!entries[billIndex]) return;

        const billEntry = entries[billIndex];

        try {
          await this.updateMainMenu(
            ctx,
            userId,
            `⏳ *در حال دریافت برنامه قطعی...*\n\n🏠 ${billEntry.alias}\n📋 ${billEntry.billId}`,
            [],
          );

          let resultMessage = `⚡ *برنامه قطعی برق*\n🏠 *${billEntry.alias}*\n📋 شناسه: \`${billEntry.billId}\`\n\n`;

          if (dateType === 'all') {
            // Check all three days
            const dates = ['today', 'tomorrow', 'dayafter'];
            const dateNames = ['امروز', 'فردا', 'پس‌فردا'];

            for (let i = 0; i < dates.length; i++) {
              const date = this.getDateForType(dates[i]);
              const periods = await this.fetchOutageData(
                billEntry.billId,
                date,
              );

              resultMessage += `📅 *${dateNames[i]} (${this.formatPersianDate(dates[i])}):*\n`;
              if (periods.length > 0) {
                resultMessage += `🔴 ${periods.join('\n🔴 ')}\n\n`;
              } else {
                resultMessage += `✅ قطعی برق پیش‌بینی نشده\n\n`;
              }
            }
          } else {
            const date = this.getDateForType(dateType);
            const periods = await this.fetchOutageData(billEntry.billId, date);
            const dateNames = {
              today: 'امروز',
              tomorrow: 'فردا',
              dayafter: 'پس‌فردا',
            };

            resultMessage += `📅 *${dateNames[dateType]} (${this.formatPersianDate(dateType)}):*\n`;
            if (periods.length > 0) {
              resultMessage += `🔴 ${periods.join('\n🔴 ')}\n`;
            } else {
              resultMessage += `✅ قطعی برق پیش‌بینی نشده`;
            }
          }

          // Add disclaimer
          resultMessage +=
            '\n\n⚠️ *توجه:* این اطلاعات ممکن است دقیق نباشند و قطعی‌های خارج از برنامه احتمالی هستند.';

          const keyboard = [
            [{ text: '🏠 منوی اصلی', callback_data: 'back_to_main' }],
            [{ text: '🔙 بازگشت', callback_data: `quick_bill_${billIndex}` }],
          ];

          await this.updateMainMenu(ctx, userId, resultMessage, keyboard);
        } catch (error) {
          await this.updateMainMenu(
            ctx,
            userId,
            `❌ *خطا در دریافت اطلاعات*\n\n🏠 ${billEntry.alias}\n\nلطفاً دوباره تلاش کنید.`,
            [
              [
                { text: '🏠 منوی اصلی', callback_data: 'back_to_main' },
                { text: '🔙 بازگشت', callback_data: `quick_bill_${billIndex}` },
              ],
            ],
          );
        }
      },
    );

    // Add bill callback
    this.bot.action('add_bill', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.scene?.enter('ADD_BILL_WIZARD');
    });

    // Manage bills callback
    this.bot.action('manage_bills', async (ctx) => {
      await ctx.answerCbQuery();
      const userId = ctx.from.id;
      const entries = await this.storageService.getEntries(userId);

      if (!entries.length) {
        await this.updateMainMenu(
          ctx,
          userId,
          '❌ هیچ قبضی برای حذف وجود ندارد.',
        );
        return;
      }

      const keyboard = entries.map((entry, index) => [
        {
          text: `🗑 حذف ${entry.alias}`,
          callback_data: `delete_${entry.billId}_${index}`,
        },
      ]);
      keyboard.push([{ text: '🔙 بازگشت', callback_data: 'back_to_main' }]);

      await this.updateMainMenu(
        ctx,
        userId,
        '🗑 *مدیریت قبوض*\n\nبرای حذف، روی قبض مورد نظر کلیک کنید:',
        keyboard,
      );
    });

    // Delete bill callback
    this.bot.action(/delete_([^_]+)_(\d+)/, async (ctx) => {
      await ctx.answerCbQuery();
      const billId = ctx.match[1];
      const originalIndex = parseInt(ctx.match[2]);
      const userId = ctx.from.id;
      const entries = await this.storageService.getEntries(userId);

      // Find current index by billId (in case indices changed)
      const currentIndex = entries.findIndex(
        (entry) => entry.billId === billId,
      );

      if (currentIndex === -1) {
        await this.updateMainMenu(ctx, userId, '❌ قبض مورد نظر یافت نشد.');
        return;
      }

      const keyboard = [
        [
          { text: '✅ بله، حذف کن', callback_data: `confirm_delete_${billId}` },
          { text: '❌ انصراف', callback_data: 'manage_bills' },
        ],
      ];

      await this.updateMainMenu(
        ctx,
        userId,
        `🗑 *تأیید حذف*\n\nآیا مطمئنید که می‌خواهید قبض "${entries[currentIndex].alias}" را حذف کنید؟`,
        keyboard,
      );
    });

    // Confirm delete callback
    this.bot.action(/confirm_delete_([^_]+)/, async (ctx) => {
      await ctx.answerCbQuery('⏳ در حال حذف...');
      const billId = ctx.match[1];
      const userId = ctx.from.id;

      try {
        const entries = await this.storageService.getEntries(userId);
        const index = entries.findIndex((entry) => entry.billId === billId);

        if (index === -1) {
          await this.updateMainMenu(ctx, userId, '❌ قبض مورد نظر یافت نشد.');
          return;
        }

        const success = await this.storageService.deleteEntry(userId, index);
        if (success) {
          await this.updateMainMenu(ctx, userId, '✅ *قبض با موفقیت حذف شد*');
        } else {
          await this.updateMainMenu(
            ctx,
            userId,
            '❌ *خطا در حذف قبض*\n\nلطفاً دوباره تلاش کنید.',
          );
        }
      } catch (error) {
        console.error('Error deleting entry:', error);
        await this.updateMainMenu(
          ctx,
          userId,
          '❌ *خطا در حذف قبض*\n\nلطفاً دوباره تلاش کنید.',
        );
      }
    });

    // Help callback
    this.bot.action('help', async (ctx) => {
      await ctx.answerCbQuery();
      const helpText = `📖 *راهنمای استفاده*

🔹 *بررسی سریع قطعی:* برای دسترسی سریع به برنامه قطعی
🔹 *دکمه‌های قبوض:* کلیک مستقیم روی نام قبض برای بررسی
🔹 *افزودن قبض:* اضافه کردن شناسه قبض جدید
🔹 *مدیریت قبوض:* حذف قبوض ذخیره شده
🔹 *گزارش امروز همه:* مشاهده گزارش برنامه قطعی همه قبوض امروز

*محدودیت:* هر کاربر می‌تواند تا ${this.DAILY_REPORT_LIMIT} گزارش در روز دریافت کند.

دستورات:
/start - شروع مجدد
/menu - نمایش منو`;

      await this.updateMainMenu(ctx, ctx.from.id, helpText, [
        [{ text: '🔙 بازگشت', callback_data: 'back_to_main' }],
      ]);
    });

    // Full report callback
    this.bot.action('full_report', async (ctx) => {
      // Check report limit
      const userId = ctx.from.id;
      const limitCheck = this.canUserRequestReport(userId);
      if (!limitCheck.allowed) {
        await ctx.answerCbQuery(limitCheck.message, { show_alert: true });
        return;
      }

      await ctx.answerCbQuery();
      const entries = await this.storageService.getEntries(userId);

      if (!entries.length) {
        await this.updateMainMenu(ctx, userId, '❌ هیچ قبضی ذخیره نشده است.');
        return;
      }

      await this.updateMainMenu(
        ctx,
        userId,
        '⏳ *در حال تهیه گزارش امروز همه...*\nلطفاً منتظر بمانید.',
        [],
      );

      try {
        let reportMessage = `📊 *گزارش امروز همه قطعی برق*\n📅 ${this.formatPersianDate('today')}\n\n`;

        for (const entry of entries) {
          const date = this.getDateForType('today');
          const periods = await this.fetchOutageData(entry.billId, date);

          reportMessage += `🏠 *${entry.alias}*\n`;
          if (periods.length > 0) {
            reportMessage += `🔴 ${periods.join('\n🔴 ')}\n\n`;
          } else {
            reportMessage += `✅ قطعی پیش‌بینی نشده\n\n`;
          }
        }

        // Add disclaimer
        reportMessage +=
          '⚠️ *توجه:* این اطلاعات ممکن است دقیق نباشند و قطعی‌های خارج از برنامه احتمالی هستند.';

        await this.updateMainMenu(ctx, userId, reportMessage, [
          [{ text: '🔙 بازگشت', callback_data: 'back_to_main' }],
        ]);
      } catch (error) {
        await this.updateMainMenu(
          ctx,
          userId,
          '❌ *خطا در تهیه گزارش*\nلطفاً دوباره تلاش کنید.',
        );
      }
    });

    // Back to main callback
    this.bot.action('back_to_main', async (ctx) => {
      await ctx.answerCbQuery();
      const userId = ctx.from.id;
      await this.updateMainMenu(ctx, userId);
    });

    // Handle bill selection (direct click on bill buttons)
    this.bot.action(/bill_(\d+)/, async (ctx) => {
      await ctx.answerCbQuery();
      const billIndex = parseInt(ctx.match[1]);
      const userId = ctx.from.id;
      const entries = await this.storageService.getEntries(userId);

      if (!entries[billIndex]) return;

      const keyboard = [
        [
          { text: '🌄 پس‌فردا', callback_data: `check_${billIndex}_dayafter` },
          { text: '📅 امروز', callback_data: `check_${billIndex}_today` },
        ],
        [
          { text: '📊 هر سه روز', callback_data: `check_${billIndex}_all` },
          { text: '🌅 فردا', callback_data: `check_${billIndex}_tomorrow` },
        ],
        [{ text: '🔙 بازگشت', callback_data: 'back_to_main' }],
      ];

      await this.updateMainMenu(
        ctx,
        userId,
        `🏠 *${entries[billIndex].alias}*\n📋 شناسه: \`${entries[billIndex].billId}\`\n\n📅 تاریخ مورد نظر را انتخاب کنید:`,
        keyboard,
      );
    });

    // Handle cancel wizard - return to main menu
    this.bot.action('cancel_wizard', async (ctx) => {
      await ctx.answerCbQuery('بازگشت به منوی اصلی...');
      await this.returnToMainMenu(ctx);
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
    interface WizardState {
      billId?: string;
    }

    interface WizardContext extends Scenes.WizardContext {
      wizard: Scenes.WizardContextWizard<WizardContext>;
      state: WizardState;
    }

    const addBillWizard = new Scenes.WizardScene<WizardContext>(
      'ADD_BILL_WIZARD',
      async (ctx) => {
        // Update main menu to show wizard state
        await this.updateMainMenu(
          ctx,
          ctx.from.id,
          '➕ *افزودن قبض جدید*\n\n📋 لطفاً شناسه قبض خود را در قسمت چت وارد کنید:\n\n💡 *راهنما:* شناسه قبض یک عدد ۱۳ رقمی است.',
          [[{ text: '❌ انصراف', callback_data: 'cancel_wizard' }]],
        );
        return ctx.wizard.next();
      },
      async (ctx) => {
        if (
          ctx.callbackQuery &&
          'data' in ctx.callbackQuery &&
          ctx.callbackQuery.data === 'cancel_wizard'
        ) {
          await ctx.answerCbQuery();
          await this.returnToMainMenu(ctx);
          return ctx.scene.leave();
        }

        // Handle /menu command in wizard
        if (
          ctx.message &&
          'text' in ctx.message &&
          ctx.message.text === '/menu'
        ) {
          await this.returnToMainMenu(ctx);
          return ctx.scene.leave();
        }

        // Handle case where user sends a message instead of clicking cancel
        if (!ctx.message || !('text' in ctx.message)) {
          return ctx.wizard.back(); // Stay in the same step
        }

        const billId = ctx.message.text;

        if (!billId.match(/^\d+$/)) {
          await this.updateMainMenu(
            ctx,
            ctx.from.id,
            '❌ *شناسه قبض نامعتبر*\n\nلطفاً فقط عدد وارد کنید.',
            [[{ text: '❌ انصراف', callback_data: 'cancel_wizard' }]],
          );
          return;
        }

        // Check if bill ID already exists
        const userId = ctx.from.id;
        const entries = await this.storageService.getEntries(userId);
        if (entries.some((e) => e.billId === billId)) {
          await this.updateMainMenu(
            ctx,
            userId,
            '⚠️ *شناسه قبض تکراری*\n\nاین شناسه قبض قبلاً ثبت شده است. لطفاً شناسه قبض دیگری وارد کنید.',
            [[{ text: '❌ انصراف', callback_data: 'cancel_wizard' }]],
          );
          return;
        }

        (ctx.wizard.state as { billId?: string }).billId = billId;

        await this.updateMainMenu(
          ctx,
          userId,
          '🏷 *نام مستعار*\n\nلطفاً یک نام کوتاه و قابل تشخیص برای این قبض وارد کنید:\n\n💡 *مثال:* خانه، دفتر، مغازه',
          [[{ text: '❌ انصراف', callback_data: 'cancel_wizard' }]],
        );
        return ctx.wizard.next();
      },
      async (ctx) => {
        if (
          ctx.callbackQuery &&
          'data' in ctx.callbackQuery &&
          ctx.callbackQuery.data === 'cancel_wizard'
        ) {
          await ctx.answerCbQuery();
          await this.returnToMainMenu(ctx);
          return ctx.scene.leave();
        }

        // Handle /menu command in wizard
        if (
          ctx.message &&
          'text' in ctx.message &&
          ctx.message.text === '/menu'
        ) {
          await this.returnToMainMenu(ctx);
          return ctx.scene.leave();
        }

        // Handle case where user sends a message instead of clicking cancel
        if (!ctx.message || !('text' in ctx.message)) {
          return ctx.wizard.back(); // Stay in the same step
        }

        const alias = ctx.message.text;
        const userId = ctx.from?.id;
        if (!userId) return;

        const billId = (ctx.wizard.state as WizardState)?.billId;
        if (!billId) return;

        const entries = await this.storageService.getEntries(userId);
        if (entries.some((e) => e.alias === alias)) {
          await this.updateMainMenu(
            ctx,
            userId,
            '⚠️ *نام تکراری*\n\nاین نام قبلاً استفاده شده. لطفاً نام دیگری انتخاب کنید.',
            [[{ text: '❌ انصراف', callback_data: 'cancel_wizard' }]],
          );
          return;
        }

        await this.storageService.saveEntry(userId, { alias, billId });

        await this.updateMainMenu(
          ctx,
          userId,
          `✅ *قبض با موفقیت ذخیره شد!*\n\n🏠 نام: ${alias}\n📋 شناسه: \`${billId}\``,
          [[{ text: '🔙 بازگشت به منو', callback_data: 'back_to_main' }]],
        );
        return ctx.scene.leave();
      },
    );

    const stage = new Scenes.Stage<WizardContext>([addBillWizard]);
    this.bot.use(stage.middleware());
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
