import React, { lazy } from 'react';
import ReactDOM from 'react-dom/client';
import { LazySuspense, StaleBuildBanner } from './components/StaleBuildBanner';
import { watchPreloadErrors } from './services/staleBuild';
import './styles.css';
// sharedcut.com/importer is its own small page: it never loads the editor, its store or the caption fonts.
const Page = lazy(() => location.pathname === '/demo' ? import('./components/showcase/Showcase') : location.pathname === '/importer' ? import('./components/Importer') : /^\/download\/?$/.test(location.pathname) ? import('./components/Download') : import('./App'));
// A tab left open across a deploy cannot load files the deploy replaced; tell the person, never reload for them.
watchPreloadErrors(window);
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><LazySuspense fallback={null}><Page/></LazySuspense><StaleBuildBanner/></React.StrictMode>);
