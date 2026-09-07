import React from 'react';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../../messages/ja.json';
import PackCompletionRewardSettings from '@/components/PackCompletionRewardSettings';
const mockFetch = vi.fn();
const card = { id: 'bonus', name: '特別カード', image_url: null, rarity: 'rare' };
const initial = { rewards: [{ collection_name: 'old', reward_card_id: card.id, card }], candidates: [card], grants: [{ collection_name: 'old', count: 2 }], completions: [] };
beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (_url, options) => new Response(JSON.stringify(options?.method ? { success: true } : initial)));
  vi.stubGlobal('fetch', mockFetch);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function mount() {
  return render(<NextIntlClientProvider locale="ja" messages={messages}><PackCompletionRewardSettings packNames={[]} defaultPackName="デフォルト" /></NextIntlClientProvider>);
}
it('removes an orphan after explaining existing recipients', async () => {
  mount();
  fireEvent.click(await screen.findByRole('button', { name: '解除' }));
  await waitFor(() => expect(mockFetch).toHaveBeenCalledWith('/api/streamer/pack-completion-rewards', expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ collectionName: 'old' }) })));
  expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('既に2人が受領済み'));
});
it('sets the default pack reward with a retroactive award warning', async () => {
  mount();
  const chooser = await screen.findByRole('combobox', { name: 'デフォルト 報酬カードを選択' });
  fireEvent.change(chooser, { target: { value: 'bonus' } });
  fireEvent.click(screen.getByRole('button', { name: '報酬を設定' }));
  await waitFor(() => expect(mockFetch).toHaveBeenCalledWith('/api/streamer/pack-completion-rewards', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ collectionName: '__default__', rewardCardId: 'bonus' }) })));
  expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('付与は取り消せません'));
  expect(screen.getByText(messages.packCompletionReward.excludedNotice)).toBeInTheDocument();
});
