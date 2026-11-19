import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import Accounts from '../portals/core-banking/Accounts.jsx';
import LedgerJournals from '../portals/core-banking/LedgerJournals.jsx';
import Transactions from '../portals/payment-processing/Transactions.jsx';
import IntelliOpsPage from '../portals/intelliops/IntelliOpsPage.jsx';
import ApprovalCenter from '../portals/intelliops/ApprovalCenter.jsx';
import ExceptionRecords from '../portals/intelliops/ExceptionRecords.jsx';
import AIInvestigation from '../portals/intelliops/AIInvestigation.jsx';
import ResolutionWorkspace from '../portals/intelliops/resolution/ResolutionWorkspace.jsx';
import ResolutionPlans from '../portals/intelliops/resolution/ResolutionPlans.jsx';
import CustomerCommunication from '../portals/intelliops/resolution/CustomerCommunication.jsx';
import PolicyAssessment from '../portals/intelliops/resolution/PolicyAssessment.jsx';

export default function PortalPage(props) {
  const { pathname, search } = useLocation();
  if (pathname === '/core-banking/accounts') return <Accounts/>;
  if (pathname === '/core-banking/journals') return <LedgerJournals/>;
  if (pathname === '/payments/transactions') return <Transactions/>;
  if (pathname === '/intelliops/exceptions') return <ExceptionRecords/>;
  if (pathname === '/intelliops/investigation') return <AIInvestigation/>;
  if (pathname === '/intelliops/workflows' && new URLSearchParams(search).has('investigation')) return <Navigate replace to={{ pathname: '/intelliops/workflows/plans', search }}/>;
  if (pathname === '/intelliops/workflows/plans') return <ResolutionPlans/>;
  if (pathname === '/intelliops/workflows/communication') return <CustomerCommunication/>;
  if (pathname === '/intelliops/workflows/policy') return <PolicyAssessment/>;
  if (pathname === '/intelliops/approvals') return <ApprovalCenter/>;
  if (pathname === '/intelliops/workflows') return <ResolutionWorkspace/>;
  if (pathname === '/intelliops/audit') return <ExceptionRecords audit/>;
  return <IntelliOpsPage {...props}/>;
}
