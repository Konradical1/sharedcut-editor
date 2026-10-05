import './components/captions.css';
import { loadCaptionFonts } from './services/fonts';
void loadCaptionFonts();
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { StaleBuildBanner } from './components/StaleBuildBanner';
import { watchPreloadErrors } from './services/staleBuild';
import './styles.css';
// A tab left open across a deploy cannot load files the deploy replaced; tell the person, never reload for them.
watchPreloadErrors(window);
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App/><StaleBuildBanner/></React.StrictMode>);
