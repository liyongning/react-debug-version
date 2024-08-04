import * as React from 'react';
import * as ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
// import reportWebVitals from './reportWebVitals';

debugger
const root = ReactDOM.createRoot(document.getElementById('root'));
// root.render(<App />);
root.render(<div id="parent">
  <div id="child1">test child1</div>
  <div id="child2">test child2</div>
</div>);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
// reportWebVitals();
