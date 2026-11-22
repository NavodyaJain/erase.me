import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { describe, expect, it, vi } from 'vitest';
import { Alert, Button, Card, Checkbox, Chip, CopyButton, ProgressBar, Skeleton, Switch, TextArea, TextField } from '../src/index.js';

describe('Button', () => {
  it('defaults to type=button, and ignores clicks while loading', async () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('type', 'button');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(
      <Button onClick={onClick} loading>
        Saving
      </Button>,
    );
    const busy = screen.getByRole('button', { name: 'Saving' });
    expect(busy).toHaveProperty('disabled', true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    await userEvent.click(busy);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('is reachable and activated by keyboard', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Go' }));
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });
});

describe('Chip', () => {
  it('always shows its text, so colour is never the only signal', () => {
    render(
      <>
        <Chip tone="good">Looks in use</Chip>
        <Chip tone="bad">Needs attention</Chip>
      </>,
    );
    expect(screen.getByText('Looks in use')).toBeTruthy();
    expect(screen.getByText('Needs attention')).toBeTruthy();
  });
});

describe('Switch', () => {
  it('exposes role=switch with its state and name, and toggles with Space and Enter', async () => {
    const onChange = vi.fn();
    render(<Switch label="Keep this" description="No request is offered." checked={false} onChange={onChange} />);
    const sw = screen.getByRole('switch', { name: 'Keep this' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(sw.getAttribute('aria-describedby')).toBeTruthy();
    sw.focus();
    await userEvent.keyboard(' ');
    await userEvent.keyboard('{Enter}');
    expect(onChange).toHaveBeenNthCalledWith(1, true);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('is disabled while busy', async () => {
    const onChange = vi.fn();
    render(<Switch label="Keep this" checked onChange={onChange} busy />);
    const sw = screen.getByRole('switch', { name: 'Keep this' });
    expect(sw).toHaveProperty('disabled', true);
    await userEvent.click(sw);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('ProgressBar', () => {
  it('exposes the value to assistive tech and clamps it', () => {
    const { rerender } = render(<ProgressBar label="Scanning the inbox" value={42.4} />);
    const bar = screen.getByRole('progressbar', { name: 'Scanning the inbox' });
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect(screen.getByText('42%')).toBeTruthy();
    rerender(<ProgressBar label="Scanning the inbox" value={250} />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
    rerender(<ProgressBar label="Scanning the inbox" value={-5} />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
  });
});

describe('Alert', () => {
  it('announces problems and warnings (role alert) and leaves information as a status', () => {
    render(
      <>
        <Alert tone="bad" title="Could not send">
          Nothing was sent.
        </Alert>
        <Alert tone="warn">Check the Sent folder.</Alert>
        <Alert tone="info">Development send.</Alert>
      </>,
    );
    expect(screen.getAllByRole('alert')).toHaveLength(2);
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });
});

describe('CopyButton', () => {
  it('copies the text it was given and says so, without keeping it', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<CopyButton text="Draft text to copy" label="Copy draft" />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy draft' }));
    expect(writeText).toHaveBeenCalledWith('Draft text to copy');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy());
    expect(screen.getByRole('status').textContent).toBe('Copied');
  });

  it('tells the person when copying is not possible', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) }, configurable: true });
    Object.defineProperty(document, 'execCommand', { value: () => false, configurable: true });
    render(<CopyButton text="x" />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Could not copy/));
  });
});

describe('fields', () => {
  it('connect label, hint and error to the control', () => {
    render(<TextField label="Subject" hint="One line." error="Required." defaultValue="" />);
    const input = screen.getByLabelText('Subject');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const described = (input.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(['One line.', 'Required.']);
  });

  it('render a labelled textarea and checkbox', async () => {
    const onChange = vi.fn();
    render(
      <>
        <TextArea label="Draft" defaultValue="Hello" />
        <Checkbox label="Select Sample Shop" onChange={onChange} />
      </>,
    );
    expect(screen.getByLabelText('Draft')).toHaveProperty('value', 'Hello');
    await userEvent.click(screen.getByLabelText('Select Sample Shop'));
    expect(onChange).toHaveBeenCalled();
  });
});

describe('accessibility', () => {
  it('a screen of primitives has no axe violations', async () => {
    const { container } = render(
      <main>
        <h1>Sample screen</h1>
        <Card title="Companies" headingLevel={2}>
          <Chip tone="info">Likely</Chip>
          <Switch label="Keep this" checked={false} onChange={() => undefined} />
          <ProgressBar label="Scan progress" value={30} />
          <TextField label="Subject" defaultValue="Request" />
          <TextArea label="Draft" defaultValue="Text" />
          <Checkbox label="Select Sample Shop" />
          <Alert tone="info" title="Note">
            Hedged text.
          </Alert>
          <Button variant="primary">Continue</Button>
          <Skeleton />
        </Card>
      </main>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
