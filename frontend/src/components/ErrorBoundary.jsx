import { Component } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import i18n from '../i18n';
export class ErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null };
    }
    static getDerivedStateFromError(error) {
        return { hasError: true, error };
    }
    componentDidCatch(error, errorInfo) {
        console.error('[ErrorBoundary] Uncaught error:', error, errorInfo);
    }
    handleReload = () => {
        window.location.reload();
    };
    render() {
        if (this.state.hasError) {
            return (<div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minHeight: '100vh',
                    padding: '2rem',
                    fontFamily: 'system-ui, sans-serif',
                    color: 'var(--text-primary)',
                }}>
          <AlertCircle size={48} style={{ color: 'var(--error-text)', marginBottom: '1rem' }}/>
          <h1 style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>{i18n.t('errorBoundary.title')}</h1>
          <p style={{ color: 'var(--text-muted)', marginBottom: '1.5rem', textAlign: 'center' }}>
            {i18n.t('errorBoundary.description')}
          </p>
          <button onClick={this.handleReload} style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    padding: '0.75rem 1.5rem',
                    backgroundColor: 'var(--primary)',
                    color: '#0f172a',
                    border: 'none',
                    borderRadius: '0.5rem',
                    cursor: 'pointer',
                    fontSize: '1rem',
                }}>
            <RefreshCw size={18}/>
            {i18n.t('errorBoundary.reload')}
          </button>
        </div>);
        }
        return this.props.children;
    }
}
