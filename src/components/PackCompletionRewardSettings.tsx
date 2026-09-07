'use client';

import { useCallback, useEffect, useState } from 'react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { useMaintenanceStatus } from './MaintenanceStatusProvider';

interface Candidate { id: string; name: string; image_url: string | null; rarity: string }
interface Setting { collection_name: string; reward_card_id: string; card: Candidate }
interface SettingsData {
  rewards: Setting[]; candidates: Candidate[];
  grants: { collection_name: string; count: number }[];
  completions: { collection_name: string | null; count: number }[];
}

/** A single fetch serves every pack, including orphaned settings. Keeping those
 * rows removable avoids permanently locking cards after catalog deletion. */
export default function PackCompletionRewardSettings({ packNames, defaultPackName, onChanged, onManageCards }: {
  packNames: string[]; defaultPackName: string; onChanged?: () => void; onManageCards?: () => void;
}) {
  const t = useTranslations('packCompletionReward');
  const { mode } = useMaintenanceStatus();
  const [data, setData] = useState<SettingsData | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/streamer/pack-completion-rewards', { cache: 'no-store' });
      if (!response.ok) throw new Error(t('unavailable'));
      const next = await response.json();
      if (![next.rewards, next.candidates, next.grants, next.completions].every(Array.isArray)) throw new Error('Invalid response');
      setData(next);
      setError('');
    } catch { setError(t('unavailable')); }
  }, [t]);
  useEffect(() => { void load(); }, [load, packNames]);
  const save = async (collectionName: string, cardId?: string) => {
    if (!data || busy || mode !== 'off') return;
    const count = data.grants.find(g => g.collection_name === collectionName)?.count ?? 0;
    const warning = count > 0 ? t('settingsChangeWarning', { count }) : t('settingsRetroactiveNotice');
    if (!window.confirm(warning)) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/streamer/pack-completion-rewards', {
        method: cardId ? 'PUT' : 'DELETE', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collectionName, ...(cardId ? { rewardCardId: cardId } : {}) }),
      });
      if (!response.ok) throw new Error(t('saveFailed'));
      await load(); onChanged?.();
    } catch { setError(t('saveFailed')); }
    finally { setBusy(false); }
  };
  const names = [...new Set(['__default__', ...packNames, ...(data?.rewards.map(r => r.collection_name) ?? [])])];
  return <section className="mt-4 border-t border-gray-600 pt-4" aria-label={t('slotLabel')}>
    <h3 className="font-semibold text-white">{t('slotLabel')}</h3>
    <p className="mt-1 text-xs text-gray-400">{t('settingsInactiveOnlyHint')}</p>
    <p className="mt-1 text-xs text-gray-400">{t('excludedNotice')}</p>
    {error && <p role="alert" className="mt-2 text-sm text-red-300">{error}</p>}
    {data && !data.candidates.length && <p className="mt-2 text-sm text-gray-300">{t('settingsEmpty')} <button type="button" className="underline" onClick={onManageCards}>{t('settingsEmptyHint')}</button></p>}
    {data && names.map(name => {
      const reward = data.rewards.find(r => r.collection_name === name);
      const label = name === '__default__' ? defaultPackName : name;
      const orphan = name !== '__default__' && !packNames.includes(name);
      const count = data.completions.find(c => c.collection_name === name)?.count ?? 0;
      return <div key={name} className="mt-3 rounded-lg bg-gray-900/50 p-3">
        <p className="break-words text-sm font-semibold text-white">{label}{orphan ? ` · ${t('orphan')}` : ''}</p>
        {reward && <div className="my-2 flex items-center gap-2 text-sm text-purple-200">
          {reward.card.image_url && <Image src={reward.card.image_url} alt="" width={35} height={49} unoptimized className="h-12 w-9 object-contain" />}
          <span className="min-w-0 break-words">{reward.card.name}</span>
          <button type="button" disabled={busy || mode !== 'off'} onClick={() => void save(name)} className="ml-auto shrink-0 rounded border border-gray-500 px-2 py-1 disabled:opacity-50">{t('settingsRemove')}</button>
        </div>}
        {!orphan && data.candidates.length > 0 && <>
          <select aria-label={`${label} ${t('settingsButton')}`} value={selected[name] ?? ''} disabled={busy || mode !== 'off'}
            onChange={e => setSelected(previous => ({ ...previous, [name]: e.target.value }))}
            className="mt-2 w-full min-w-0 rounded bg-gray-700 p-2 text-sm text-white">
            <option value="">{t('settingsButton')}</option>
            {data.candidates.map(card => <option key={card.id} value={card.id}>{card.name} · {card.rarity}</option>)}
          </select>
          {selected[name] && <div className="mt-2">
            {data.candidates.find(c => c.id === selected[name])?.image_url && <Image src={data.candidates.find(c => c.id === selected[name])!.image_url!} alt="" width={70} height={98} unoptimized className="mb-2 h-24 w-16 object-contain" />}
            <button type="button" onClick={() => void save(name, selected[name])} disabled={busy || mode !== 'off'} className="rounded bg-purple-600 px-3 py-2 text-sm text-white disabled:opacity-50">{t('settingsSave')}</button>
          </div>}
          <p className="mt-2 text-xs text-gray-400">{t('settingsRetroactiveNotice')} {t('completionEstimate', { count })}</p>
        </>}
      </div>;
    })}
  </section>;
}
