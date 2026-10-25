import { Component, type ReactNode } from "react";

/** One failing panel shows a quiet notice instead of taking the whole page down with it. */
export class SectionBoundary extends Component<{ children: ReactNode; name: string }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    console.error(`[${this.props.name}]`, error);
  }

  override render() {
    if (this.state.failed) {
      return (
        <section className="rounded-xl border px-6 py-10 text-center text-muted-foreground">
          This panel hit an error. Reload the page to try again.
        </section>
      );
    }
    return this.props.children;
  }
}
