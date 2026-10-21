import * as sdk from '../../packages/web/src/index.js';
import * as bcReact from '../../packages/react/src/index.js';
import * as bcRouter from '../../packages/react/src/react-router.js';
import * as React from 'react';
import * as ReactDOMClient from 'react-dom/client';
import * as Router from 'react-router';

// One SDK instance shared by the page and the React helpers.
Object.assign(window as unknown as Record<string, unknown>, { BC: sdk, BCReact: bcReact, BCRouter: bcRouter, React, ReactDOMClient, Router });
