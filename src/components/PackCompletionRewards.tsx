'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import Image from 'next/image';
import type { CompletionRewardView } from '@/lib/pack-completion-reward';

export default function PackCompletionRewards({ rewards, defaultPackName }: {
  rewards: CompletionRewardView[]; defaultPackName: string;
}) {
  const t = useTranslations('packCompletionReward');
  const [index, setIndex] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const newlyGranted = rewards.filter(r => r.state === 'grantedNow');
  const current = newlyGranted[index];
  const packName = (key: string) => key === '__default__' ? defaultPackName : key;
  useEffect(() => {
    // Native modal dialog supplies focus trapping, Escape and restoration.
    if (current && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [current]);
  if (!rewards.length) return null;
  const next = () => { dialog.current?.close(); setIndex(i => i + 1); };
  return <section aria-label={t('slotLabel')} className="mb-6 grid gap-3 sm:grid-cols-2">
    {rewards.map(reward => <div key={reward.collectionName} className="flex min-w-0 items-center gap-3 rounded-xl border border-purple-700 bg-gray-800 p-3">
      {reward.state === 'locked' ? <div aria-hidden="true" className="flex h-20 w-14 shrink-0 items-center justify-center rounded-lg bg-purple-950 text-3xl text-purple-200">?</div>
        : reward.card.image_url ? <Image src={reward.card.image_url} alt={reward.card.name} width={56} height={80} unoptimized className="h-20 w-14 shrink-0 rounded object-contain" /> : null}
      <div className="min-w-0 text-sm text-white">
        <p className="break-words font-semibold">{packName(reward.collectionName)} · {t('slotLabel')}</p>
        {reward.state === 'locked' ? <><p className="text-purple-300">{reward.rarity}</p><p className="text-gray-400">{t('slotLocked')}</p></>
          : <><p>{reward.card.name}</p><p className="text-purple-300">{t('obtainedBadge')}</p></>}
      </div>
    </div>)}
    {current && current.state !== 'locked' && <dialog ref={dialog} aria-label={t('revealTitle', { packName: packName(current.collectionName) })}
      onCancel={event => { event.preventDefault(); next(); }}
      onClick={event => { if (event.target === event.currentTarget) next(); }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl bg-gray-800 p-6 text-center text-white backdrop:bg-black/75">
      <h2 className="mb-4 text-lg font-bold">{t('revealTitle', { packName: packName(current.collectionName) })}</h2>
      {current.card.image_url && <Image src={current.card.image_url} alt={current.card.name} width={210} height={294} unoptimized className="mx-auto mb-3 max-h-[45vh] object-contain motion-safe:animate-[pulse_1s_ease-out_1]" />}
      <p>{current.card.name}</p>
      <button type="button" autoFocus onClick={next} className="mt-5 rounded-lg bg-purple-600 px-6 py-2">{t('revealClose')}</button>
    </dialog>}
  </section>;
}
