import type { Metadata } from 'next';
import { RequestsList } from '@/components/RequestsList';
import { copy } from '@/copy/en';

export const metadata: Metadata = { title: copy.requests.title };

export default function RequestsPage() {
  return <RequestsList />;
}
