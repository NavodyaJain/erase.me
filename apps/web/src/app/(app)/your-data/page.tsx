import type { Metadata } from 'next';
import { YourDataScreen } from '@/components/YourDataScreen';
import { copy } from '@/copy/en';

export const metadata: Metadata = { title: copy.yourData.title };

export default function YourDataPage() {
  return <YourDataScreen />;
}
