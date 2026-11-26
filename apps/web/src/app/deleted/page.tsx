import type { Metadata } from 'next';
import { DeletedScreen } from '@/components/DeletedScreen';
import { copy } from '@/copy/en';

export const metadata: Metadata = { title: copy.yourData.signedOutTitle };

export default function DeletedPage() {
  return <DeletedScreen />;
}
