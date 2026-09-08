import React from 'react';
import { render, screen } from '@testing-library/react';
import { it, expect, vi } from 'vitest';
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
import PackCompletionRewards from '@/components/PackCompletionRewards';
it('renders locked rarity without a card image or identity', () => {
  const { container } = render(<PackCompletionRewards rewards={[{ collectionName: '__default__', state: 'locked', rarity: 'legendary' }]} defaultPackName="Default" />);
  expect(screen.getByText('legendary')).toBeInTheDocument();
  expect(container.querySelector('img')).toBeNull();
  expect(screen.getByText('?')).toBeInTheDocument();
});
it('renders nothing when no rewards are configured', () => {
  const { container } = render(<PackCompletionRewards rewards={[]} defaultPackName="Default" />);
  expect(container).toBeEmptyDOMElement();
});
