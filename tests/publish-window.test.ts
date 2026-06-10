import { describe, expect, it } from 'vitest';
import { checkChannelPublishWindowAt } from '../apps/worker-api/src/services/rule-gate';

describe('publish-time channel windows', () => {
  const channel = {
    timezone: 'Asia/Tehran',
    allowed_windows: '["07:00-23:59","00:00-01:00"]',
    blocked_windows: '["01:00-07:00"]',
  };

  it('blocks publishing at 04:30 Tehran', () => {
    const at0430Tehran = Date.parse('2026-06-05T01:00:00.000Z') / 1000;
    expect(checkChannelPublishWindowAt(channel, at0430Tehran)).toBe('publish_window_blocked');
  });

  it('allows publishing at 08:00 Tehran', () => {
    const at0800Tehran = Date.parse('2026-06-05T04:30:00.000Z') / 1000;
    expect(checkChannelPublishWindowAt(channel, at0800Tehran)).toBeNull();
  });

  it('allows publishing at 00:30 Tehran', () => {
    const at0030Tehran = Date.parse('2026-06-04T21:00:00.000Z') / 1000;
    expect(checkChannelPublishWindowAt(channel, at0030Tehran)).toBeNull();
  });

  it('blocks publishing at 01:00 Tehran exactly', () => {
    const at0100Tehran = Date.parse('2026-06-04T21:30:00.000Z') / 1000;
    expect(checkChannelPublishWindowAt(channel, at0100Tehran)).toBe('publish_window_blocked');
  });
});
