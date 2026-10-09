import { Component } from 'react';
import Callout from './Callout.jsx';

// Catches render errors so one broken page does not blank the whole app.
// Changing resetKey (for example the route path) clears the error.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.reset = this.reset.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidUpdate(prev) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.reset();
  }

  componentDidCatch(error) {
    if (typeof console !== 'undefined') console.error(error);
  }

  reset() {
    this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const detail = this.state.error && this.state.error.message ? String(this.state.error.message) : '';
    return (
      <div className="ui-container ui-boundary">
        <Callout tone="bad" title="Something went wrong on this page">
          <p>The page stopped working. Nothing was sent or changed. You can try again or reload the page.</p>
          {detail ? <p className="ui-muted">Detail: {detail}</p> : null}
          <div className="ui-row">
            <button type="button" className="ui-btn ui-btn--secondary" onClick={this.reset}>
              <span className="ui-btn__label">Try again</span>
            </button>
            <button type="button" className="ui-btn ui-btn--ghost" onClick={() => window.location.reload()}>
              <span className="ui-btn__label">Reload page</span>
            </button>
          </div>
        </Callout>
      </div>
    );
  }
}

export { ErrorBoundary };
