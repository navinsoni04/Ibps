import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const motivationItems = pgTable('motivation_items', {
  id: uuid().primaryKey(),
  ownerId: text('owner_id').notNull(),
  category: text({ enum: ['affirmation', 'song', 'video'] }).notNull(),
  kind: text({ enum: ['text', 'link', 'file'] }).notNull(),
  title: text().notNull(),
  content: text(),
  mediaType: text('media_type'),
  byteSize: integer('byte_size'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index('motivation_items_owner_created_idx').on(table.ownerId, table.createdAt)]);
