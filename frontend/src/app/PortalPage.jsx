import React from 'react';
import { useLocation } from 'react-router-dom';
import Accounts from '../portals/core-banking/Accounts.jsx';
import LedgerJournals from '../portals/core-banking/LedgerJournals.jsx';
import Transactions from '../portals/payment-processing/Transactions.jsx';
import IntelliOpsPage from '../portals/intelliops/IntelliOpsPage.jsx';
import ExceptionRecords from '../portals/intelliops/ExceptionRecords.jsx';
import AIInvestigation from '../portals/intelliops/AIInvestigation.jsx';
import ResolutionHandoff from '../portals/intelliops/investigation/ResolutionHandoff.jsx';

export default function PortalPage(props) {
  const { pathname, search } = useLocation();
  if (pathname === '/core-banking/accounts') return <Accounts/>;
  if (pathname === '/core-banking/journals') return <LedgerJournals/>;
  if (pathname === '/payments/transactions') return <Transactions/>;
  if (pathname === '/intelliops/exceptions') return <ExceptionRecords/>;
  if (pathname === '/intelliops/investigation') return <AIInvestigation/>;
  if (pathname === '/intelliops/workflows' && new URLSearchParams(search).has('investigation')) return <ResolutionHandoff/>;
  if (pathname === '/intelliops/audit') return <ExceptionRecords audit/>;
  return <IntelliOpsPage {...props}/>;
}
