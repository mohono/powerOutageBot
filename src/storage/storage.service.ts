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
    try {
      const data = await fs.readFile(this.storagePath, 'utf8');
      const allEntries = JSON.parse(data);
      return allEntries[userId] || [];
    } catch (error) {
      return [];
    }
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
    } catch (error) {
      return {};
    }
  }

  private async saveAllEntries(entries: Record<number, BillEntry[]>): Promise<void> {
    await fs.writeFile(this.storagePath, JSON.stringify(entries, null, 2), 'utf8');
  }
}
