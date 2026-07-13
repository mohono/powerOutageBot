/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';

interface BillEntry {
  alias: string;
  billId: string;
}

@Injectable()
export class StorageService {
  private readonly storagePath = path.join(process.cwd(), 'bills.json');

  async getEntries(userId: number): Promise<BillEntry[]> {
    const allEntries = await this.getAllEntries();
    return allEntries[userId] || [];
  }

  async saveEntry(userId: number, entry: BillEntry): Promise<void> {
    const allEntries = await this.getAllEntries();
    if (!allEntries[userId]) {
      allEntries[userId] = [];
    }
    allEntries[userId].push(entry);
    await this.saveAllEntries(allEntries);
  }

  async deleteEntry(userId: number, index: number): Promise<boolean> {
    const allEntries = await this.getAllEntries();
    if (allEntries[userId]?.[index]) {
      allEntries[userId].splice(index, 1);
      await this.saveAllEntries(allEntries);
      return true;
    }
    return false;
  }

  private async getAllEntries(): Promise<Record<number, BillEntry[]>> {
    try {
      const data = await fs.readFile(this.storagePath, 'utf8');
      return JSON.parse(data);
    } catch (err: unknown) {
      if ((err as any)?.code === 'ENOENT') {
        return {};
      }
      throw err;
    }
  }

  private async saveAllEntries(
    entries: Record<number, BillEntry[]>,
  ): Promise<void> {
    await fs.writeFile(
      this.storagePath,
      JSON.stringify(entries, null, 2),
      'utf8',
    );
  }
}
