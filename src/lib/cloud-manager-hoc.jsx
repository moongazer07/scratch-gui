import PropTypes from 'prop-types';
import React from 'react';
import {connect} from 'react-redux';
import bindAll from 'lodash.bindall';

import VM from 'scratch-vm';
import CloudProvider from '../lib/cloud-provider';

import {
    getIsShowingProject,
    getIsShowingWithId
} from '../reducers/project-state';

import {
    showAlertWithTimeout
} from '../reducers/alerts';
import {openUsernameModal} from '../reducers/modals';
import {setUsernameInvalid, setCloudHost} from '../reducers/tw';

/**
 * TW: Our scratch-vm has an alternative fix to the cloud variable and video sensing privacy concerns.
 */
const DISABLE_WITH_VIDEO_SENSING = false;

/*
 * Higher Order Component to manage the connection to the cloud server.
 * @param {React.Component} WrappedComponent component to manage VM events for
 * @returns {React.Component} connected component with vm events bound to redux
 */
const cloudManagerHOC = function (WrappedComponent) {
    class CloudManager extends React.Component {
        constructor (props) {
            super(props);
            this.cloudProvider = null;
            bindAll(this, [
                'handleCloudDataUpdate',
                'handleExtensionAdded'
            ]);

            this.props.vm.on('HAS_CLOUD_DATA_UPDATE', this.handleCloudDataUpdate);
            this.props.vm.on('EXTENSION_ADDED', this.handleExtensionAdded);
        }
        componentDidMount () {
            if (this.shouldConnect(this.props)) {
                this.connectToCloud();
            }
        }
        componentWillReceiveProps (nextProps) {
            if (this.props.reduxCloudHost !== nextProps.cloudHost) {
                this.props.onSetReduxCloudHost(nextProps.cloudHost);
            }
        }
        componentDidUpdate (prevProps) {
            // TODO need to add cloud provider disconnection logic and cloud data clearing logic
            // when loading a new project e.g. via file upload
            // (and eventually move it out of the vm.clear function)

            if (this.shouldConsiderReconnecting(this.props, prevProps)) {
                this.disconnectFromCloud();
                if (this.shouldConnect(this.props)) {
                    this.connectToCloud();
                }
                return;
            }

            if (this.shouldConnect(this.props) && !this.shouldConnect(prevProps)) {
                this.connectToCloud();
            }

            if (this.shouldDisconnect(this.props, prevProps)) {
                this.shouldDisconnect(this.props, prevProps);
                this.disconnectFromCloud();
            }
        }
        componentWillUnmount () {
            this.props.vm.off('HAS_CLOUD_DATA_UPDATE', this.handleCloudDataUpdate);
            this.props.vm.off('EXTENSION_ADDED', this.handleExtensionAdded);
            this.disconnectFromCloud();
        }
        canUseCloud (props) {
            return !!(
                props.reduxCloudHost &&
                props.username &&
                props.vm &&
                props.projectId &&
                props.hasCloudPermission
            );
        }
        shouldConnect (props) {
            return !this.isConnected() && this.canUseCloud(props) &&
                props.isShowingProject && props.vm.runtime.hasCloudData() &&
                props.canModifyCloudData;
        }
        shouldDisconnect (props, prevProps) {
            return this.isConnected() &&
                ( // Can no longer use cloud or cloud provider info is now stale
                    !this.canUseCloud(props) ||
                    !props.vm.runtime.hasCloudData() ||
                    props.projectId !== prevProps.projectId ||
                    // Editing someone else's project
                    !props.canModifyCloudData
                );
        }
        shouldConsiderReconnecting (props, prevProps) {
            return this.isConnected() && (
                props.username !== prevProps.username ||
                props.projectId !== prevProps.projectId ||
                props.reduxCloudHost !== prevProps.reduxCloudHost
            );
        }
        isConnected () {
            return this.cloudProvider && !!this.cloudProvider.connection;
        }
        connectToCloud () {
            this.cloudProvider = new CloudProvider(
                this.props.reduxCloudHost,
                this.props.vm,
                this.props.username,
                this.props.projectId);
            this.cloudProvider.onInvalidUsername = this.onInvalidUsername;
            this.props.vm.setCloudProvider(this.cloudProvider);
        }
        disconnectFromCloud () {
            if (this.cloudProvider) {
                this.cloudProvider.requestCloseConnection();
                this.cloudProvider = null;
                this.props.vm.setCloudProvider(null);
            }
        }
        handleCloudDataUpdate (projectHasCloudData) {
            if (this.isConnected() && !projectHasCloudData) {
                this.disconnectFromCloud();
            } else if (this.shouldConnect(this.props)) {
                this.props.onShowCloudInfo();
                this.connectToCloud();
            }
        }
        handleExtensionAdded (categoryInfo) {
            // Note that props.vm.extensionManager.isExtensionLoaded('videoSensing') is still false
            // at the point of this callback, so it is difficult to reuse the canModifyCloudData logic.
            if (DISABLE_WITH_VIDEO_SENSING && categoryInfo.id === 'videoSensing' && this.isConnected()) {
                this.disconnectFromCloud();
            }
        }
        render () {
            const {
                /* eslint-disable no-unused-vars */
                canModifyCloudData,
                cloudHost,
                reduxCloudHost,
                onSetReduxCloudHost,
                projectId,
                username,
                hasCloudPermission,
                isShowingProject,
                onShowCloudInfo,
                onInvalidUsername,
                /* eslint-enable no-unused-vars */
                vm,
                ...componentProps
            } = this.props;
            return (
                <WrappedComponent
                    canUseCloud={this.canUseCloud(this.props)}
                    vm={vm}
                    {...componentProps}
                />
            );
        }
    }

    CloudManager.propTypes = {
        canModifyCloudData: PropTypes.bool.isRequired,
        cloudHost: PropTypes.string,
        reduxCloudHost: PropTypes.string,
        onSetReduxCloudHost: PropTypes.func,
        hasCloudPermission: PropTypes.bool,
        isShowingProject: PropTypes.bool.isRequired,
        onInvalidUsername: PropTypes.func,
        onShowCloudInfo: PropTypes.func,
        projectId: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
        username: PropTypes.string,
        vm: PropTypes.instanceOf(VM).isRequired
    };

    CloudManager.defaultProps = {
        cloudHost: null,
        onShowCloudInfo: () => {},
        username: null
    };

    const mapStateToProps = (state, ownProps) => {
        const loadingState = state.scratchGui.projectState.loadingState;
        const baseProjectId = getIsShowingWithId(loadingState) || !getIsShowingProject(loadingState) ? (
            state.scratchGui.projectState.projectId
        ) : (
            `@gui/${state.scratchGui.projectTitle}`
        );
        return {
            isShowingProject: getIsShowingProject(loadingState),
            projectId: state.scratchGui.mode.hasEverEnteredEditor ? `@editor/${baseProjectId}` : baseProjectId,
            hasCloudPermission: state.scratchGui.tw ? state.scratchGui.tw.cloud : false,
            username: state.scratchGui.tw ? state.scratchGui.tw.username : '',
            canModifyCloudData: !(
                DISABLE_WITH_VIDEO_SENSING && ownProps.vm.extensionManager.isExtensionLoaded('videoSensing')
            ),
            reduxCloudHost: state.scratchGui.tw.cloudHost
        };
    };

    const mapDispatchToProps = dispatch => ({
        onSetReduxCloudHost: cloudHost => dispatch(setCloudHost(cloudHost)),
        onShowCloudInfo: () => showAlertWithTimeout(dispatch, 'cloudInfo'),
        onInvalidUsername: () => {
            dispatch(setUsernameInvalid(true));
            dispatch(openUsernameModal());
        }
    });

    // Allow incoming props to override redux-provided props. Used to mock in tests.
    const mergeProps = (stateProps, dispatchProps, ownProps) => Object.assign(
        {}, stateProps, dispatchProps, ownProps
    );

    return connect(
        mapStateToProps,
        mapDispatchToProps,
        mergeProps
    )(CloudManager);
};

export default cloudManagerHOC;
