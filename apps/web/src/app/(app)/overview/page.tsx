import type { Metadata } from 'next';
import { OverviewScreen } from '@/components/OverviewScreen';
import { copy } from '@/copy/en';

export const metadata: Metadata = { title: copy.overview.title };

export default function OverviewPage() {
  return <OverviewScreen />;
}
