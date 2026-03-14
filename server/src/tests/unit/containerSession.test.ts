/**
 * ContainerSession — classifyDockerError unit tests (Fix 2.3)
 *
 * classifyDockerError is an exported pure function with no side effects —
 * no mocking required.
 */
import { describe, it, expect } from 'vitest';
import { classifyDockerError, DockerErrorType } from '../../execution/ContainerSession';

describe('classifyDockerError', () => {
    it('returns daemon_down for "cannot connect to the docker daemon"', () => {
        const result = classifyDockerError('Cannot connect to the Docker daemon at unix:///var/run/docker.sock');
        expect(result).toBe<DockerErrorType>('daemon_down');
    });

    it('returns daemon_down for "is the docker daemon running"', () => {
        const result = classifyDockerError('Is the docker daemon running?');
        expect(result).toBe<DockerErrorType>('daemon_down');
    });

    it('returns image_missing for "no such image"', () => {
        const result = classifyDockerError('Error: No such image: myapp:latest');
        expect(result).toBe<DockerErrorType>('image_missing');
    });

    it('returns image_missing for "manifest unknown"', () => {
        const result = classifyDockerError('manifest unknown: manifest unknown');
        expect(result).toBe<DockerErrorType>('image_missing');
    });

    it('returns resource_limit for OOM message', () => {
        const result = classifyDockerError('Container killed due to OOM — out of memory');
        expect(result).toBe<DockerErrorType>('resource_limit');
    });

    it('returns resource_limit for "no space left"', () => {
        const result = classifyDockerError('Write failed: no space left on device');
        expect(result).toBe<DockerErrorType>('resource_limit');
    });

    it('returns permission for "permission denied"', () => {
        const result = classifyDockerError('permission denied while trying to connect to the Docker daemon socket');
        expect(result).toBe<DockerErrorType>('permission');
    });

    it('returns permission for "access denied"', () => {
        const result = classifyDockerError('Error: access denied to /var/run/docker.sock');
        expect(result).toBe<DockerErrorType>('permission');
    });

    it('returns unknown for an unrecognized error message', () => {
        const result = classifyDockerError('container exited with code 1');
        expect(result).toBe<DockerErrorType>('unknown');
    });

    it('is case-insensitive', () => {
        expect(classifyDockerError('CANNOT CONNECT TO THE DOCKER DAEMON')).toBe<DockerErrorType>('daemon_down');
    });
});
