import type { Metadata } from 'next';
import { RequestDetail } from '@/components/RequestDetail';
import { copy } from '@/copy/en';

export const metadata: Metadata = { title: copy.requests.detailsTitle };

export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RequestDetail id={id} />;
}
