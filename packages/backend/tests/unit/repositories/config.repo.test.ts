import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ConfigRepository } from '@infos/backend/repositories/config.repo'
import * as schema from '../../../src/database/schema'

describe('关联配置的原子提交', () => {
  it('维度写入失败时不留下已经更新的模型或新配置键', async () => {
    const sqlite = new Database(':memory:')
    try {
      sqlite.exec(`
        CREATE TABLE configs (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
        INSERT INTO configs (key, value) VALUES ('embedding.model', 'old-model');
        INSERT INTO configs (key, value) VALUES ('embedding.dimension', '1536');
        CREATE TRIGGER reject_dimension BEFORE UPDATE ON configs
        WHEN NEW.key = 'embedding.dimension' AND NEW.value = '3072'
        BEGIN SELECT RAISE(ABORT, '模拟维度保存失败'); END;
      `)
      const repository = new ConfigRepository(drizzle(sqlite, { schema }))
      await expect(
        repository.replaceMany([
          ['embedding.model', 'new-model'],
          ['embedding.apiBase', 'https://embedding.example/v1'],
          ['embedding.dimension', '3072'],
        ]),
      ).rejects.toThrow()
      expect(await repository.get('embedding.model')).toBe('old-model')
      expect(await repository.get('embedding.dimension')).toBe('1536')
      expect(await repository.get('embedding.apiBase')).toBeUndefined()
    } finally {
      sqlite.close()
    }
  })
})
