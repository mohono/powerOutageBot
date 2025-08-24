/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Telegraf, Scenes, session } from 'telegraf';
import axios from 'axios';
import { toJalaali } from 'jalaali-js';
import { StorageService } from '../storage/storage.service';

interface BillEntry {
  alias: string;
  billId: string;
}

@Injectable()
export class TelegramService implements OnModuleInit {
  private bot: Telegraf<Scenes.WizardContext>;
  constructor(private readonly storageService: StorageService) {
    this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
    this.setupMiddlewares();
    this.setupWizard(); // Setup wizard first
    this.setupCommands();
  }

  onModuleInit() {
    this.bot.launch();
  }

  private setupMiddlewares() {
    this.bot.use(session());
  }

  private setupCommands() {
    this.bot.command('start', (ctx) => {
      ctx.reply(`به ربات قطعی برق خوش آمدید!
/add - ثبت شناسه قبض جدید
/check - بررسی زمان‌های قطعی
/delete - حذف شناسه قبض ذخیره شده`);
    });

    this.bot.command('add', (ctx) => ctx.scene?.enter('ADD_BILL_WIZARD'));
    this.bot.command('check', (ctx) => ctx.scene?.enter('CHECK_OUTAGE_WIZARD'));
    this.bot.command('delete', (ctx) => ctx.scene?.enter('DELETE_BILL_WIZARD'));
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
        await ctx.reply('لطفا شناسه قبض خود را وارد کنید:');
        return ctx.wizard.next();
      },
      async (ctx) => {
        const billId =
          'text' in (ctx.message ?? {})
            ? (ctx.message as { text: string }).text
            : undefined;
        if (!billId?.match(/^\d+$/)) {
          await ctx.reply('شناسه قبض نامعتبر. لطفا فقط عدد وارد کنید.');
          return;
        }
        (ctx.wizard.state as { billId?: string }).billId = billId;
        await ctx.reply(
          'لطفا یک نام مستعار برای این قبض وارد کنید (مثلا "خانه"):',
        );
        return ctx.wizard.next();
      },
      async (ctx) => {
        const alias =
          'text' in (ctx.message ?? {})
            ? (ctx.message as { text: string }).text
            : undefined;
        const userId = ctx.from?.id;
        if (!userId) return;
        const billId = (ctx.wizard.state as WizardState)?.billId;

        const entries = await this.storageService.getEntries(userId);
        if (entries.some((e) => e.alias === alias)) {
          await ctx.reply(
            'این نام قبلا استفاده شده. لطفا نام دیگری انتخاب کنید.',
          );
          return;
        }

        await this.storageService.saveEntry(userId, { alias, billId });
        await ctx.reply(`ذخیره شد! از دستور /check برای مشاهده زمان قطعی استفاده کنید`);
        return ctx.scene.leave();
      },
    );

    const checkOutageWizard = new Scenes.WizardScene<WizardContext>(
      'CHECK_OUTAGE_WIZARD',
      async (ctx) => {
        const userId = ctx.from.id;
        const entries = await this.storageService.getEntries(userId);

        if (!entries?.length) {
          await ctx.reply('هیچ قبضی ذخیره نشده. ابتدا از دستور /add استفاده کنید.');
          return ctx.scene.leave();
        }

        const buttons = entries.map((entry) => [
          { text: entry.alias, callback_data: entry.billId },
        ]);

        await ctx.reply('یک قبض انتخاب کنید:', {
          reply_markup: {
            inline_keyboard: buttons,
          },
        });
        return ctx.wizard.next();
      },
      async (ctx) => {
        if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;

        (ctx.wizard.state as { billId?: string }).billId =
          ctx.callbackQuery.data;
        const buttons = [
          [{ text: 'امروز', callback_data: 'today' }],
          [{ text: 'فردا', callback_data: 'tomorrow' }],
          [{ text: 'پس فردا', callback_data: 'dayafter' }],
        ];

        await ctx.reply('تاریخ را انتخاب کنید:', {
          reply_markup: { inline_keyboard: buttons },
        });
        return ctx.wizard.next();
      },
      async (ctx) => {
        if (!('data' in ctx.callbackQuery)) return;

        const dateType = ctx.callbackQuery.data;
        const date = this.getDateForType(dateType);
        const billId = (ctx.wizard.state as { billId?: string }).billId;

        try {
          await ctx.sendChatAction('typing');
          const response = await axios.get(
            'http://85.185.251.108:8007/home/popfeeder',
            {
              params: {
                date: date,
                id: billId,
              },
              headers: {
                accept: 'application/json, text/plain, */*',
                'accept-language': 'en-US,en;q=0.9,de;q=0.8',
                Referer: 'http://www.kpedc.com/',
                'User-Agent':
                  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
              },
            },
          );
          const periods = [
            ...new Set(response.data.data.map((item) => item.period)),
          ];
          await ctx.reply(`زمان‌های قطعی:\n${periods.join('\n')}`);
        } catch (error) {
          await ctx.reply(
            'خطا در دریافت برنامه قطعی. لطفا مجددا تلاش کنید.',
          );
        }

        return ctx.scene.leave();
      },
    );

    const deleteBillWizard = new Scenes.WizardScene<WizardContext>(
      'DELETE_BILL_WIZARD',
      async (ctx) => {
        const userId = ctx.from?.id;
        if (!userId) return;

        const entries = await this.storageService.getEntries(userId);
        if (!entries.length) {
          await ctx.reply('هیچ قبضی برای حذف وجود ندارد.');
          return ctx.scene.leave();
        }

        const buttons = entries.map((entry, index) => [
          {
            text: `${entry.alias} (${entry.billId})`,
            callback_data: index.toString(),
          },
        ]);

        await ctx.reply('قبض مورد نظر برای حذف را انتخاب کنید:', {
          reply_markup: { inline_keyboard: buttons },
        });
        return ctx.wizard.next();
      },
      async (ctx) => {
        if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
        const userId = ctx.from?.id;
        if (!userId) return;

        const index = parseInt(ctx.callbackQuery.data);
        if (isNaN(index)) {
          await ctx.reply('انتخاب نامعتبر');
          return ctx.scene.leave();
        }

        const success = await this.storageService.deleteEntry(userId, index);
        if (success) {
          await ctx.reply('قبض با موفقیت حذف شد');
        } else {
          await ctx.reply('خطا در حذف قبض');
        }

        return ctx.scene.leave();
      },
    );

    const stage = new Scenes.Stage<WizardContext>([
      addBillWizard,
      checkOutageWizard,
      deleteBillWizard,
    ]);
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
