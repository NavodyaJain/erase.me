import type { Metadata } from 'next';
import { ReviewScreen } from '@/components/ReviewScreen';
import { copy } from '@/copy/en';

export const metadata: Metadata = { title: copy.requests.reviewTitle };

export default function ReviewPage() {
  return <ReviewScreen />;
}
