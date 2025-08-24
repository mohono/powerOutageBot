/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Telegraf, Scenes, session } from 'telegraf';
import { DateTime } from 'luxon';
import axios from 'axios';

interface BillEntry {
  alias: string;
  billId: string;
}

@Injectable()
export class TelegramService implements OnModuleInit {
  private bot: Telegraf<Scenes.WizardContext>;
  private userStorage = new Map<number, BillEntry[]>();

  constructor() {
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
      ctx.reply('Welcome to Power Outage Bot! Use /add to register a bill ID');
    });

    this.bot.command('add', (ctx) => ctx.scene?.enter('ADD_BILL_WIZARD'));
    this.bot.command('check', (ctx) => ctx.scene?.enter('CHECK_OUTAGE_WIZARD'));
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
        await ctx.reply('Please enter your bill ID:');
        return ctx.wizard.next();
      },
      async (ctx) => {
        const billId =
          'text' in (ctx.message ?? {})
            ? (ctx.message as { text: string }).text
            : undefined;
        if (!billId?.match(/^\d+$/)) {
          await ctx.reply('Invalid bill ID. Please enter numbers only.');
          return;
        }
        (ctx.wizard.state as { billId?: string }).billId = billId;
        await ctx.reply(
          'Now please enter an alias for this bill (e.g. "home"):',
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

        if (!this.userStorage.has(userId)) {
          this.userStorage.set(userId, []);
        }

        this.userStorage.get(userId).push({ alias, billId });
        await ctx.reply(`Saved! Use /check to view outage times`);
        return ctx.scene.leave();
      },
    );

    const checkOutageWizard = new Scenes.WizardScene<WizardContext>(
      'CHECK_OUTAGE_WIZARD',
      async (ctx) => {
        const userId = ctx.from.id;
        const entries = this.userStorage.get(userId);

        if (!entries?.length) {
          await ctx.reply('No saved bills. Use /add to register one first.');
          return ctx.scene.leave();
        }

        const buttons = entries.map((entry) => [
          { text: entry.alias, callback_data: entry.billId },
        ]);

        await ctx.reply('Select a bill:', {
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
          [{ text: 'Today', callback_data: 'today' }],
          [{ text: 'Tomorrow', callback_data: 'tomorrow' }],
          [{ text: 'Day after tomorrow', callback_data: 'dayafter' }],
        ];

        await ctx.reply('Select date:', {
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
                date: date.toFormat('yyyy/LL/dd'),
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
          console.log(response.data);
          const periods = [
            ...new Set(response.data.data.map((item) => item.period)),
          ];
          await ctx.reply(`Outage times:\n${periods.join('\n')}`);
        } catch (error) {
          await ctx.reply(
            'Error fetching outage schedule. Please try again later.',
          );
        }

        return ctx.scene.leave();
      },
    );

    const stage = new Scenes.Stage<WizardContext>([
      addBillWizard,
      checkOutageWizard,
    ]);
    this.bot.use(stage.middleware());
  }

  private getDateForType(type: string): DateTime {
    const now = DateTime.now();
    switch (type) {
      case 'tomorrow':
        return now.plus({ days: 1 });
      case 'dayafter':
        return now.plus({ days: 2 });
      default:
        return now;
    }
  }
}
